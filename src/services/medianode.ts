import { EventEmitter } from 'stream';
import path from 'path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { redisServer } from '../servers/redis-server';
import { getRedisKey } from '../lib/utils';
import { MediaNodeData } from '../types';
import { ProtoGrpcType } from '../protos/gen/media-signaling';
import { MediaSignalingClient } from '../protos/gen/mediaSignalingPackage/MediaSignaling';
import { MessageRequest } from '../protos/gen/mediaSignalingPackage/MessageRequest';
import { MessageResponse__Output } from '../protos/gen/mediaSignalingPackage/MessageResponse';
import config from '../config';
import { MediaSignalingActions as MSA } from '../types/actions';

const PROTO_FILE = path.resolve(__dirname, '../protos/media-signaling.proto');
const packageDefinition = protoLoader.loadSync(PROTO_FILE);
const protoDescriptor = grpc.loadPackageDefinition(
  packageDefinition
) as unknown as ProtoGrpcType;

enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  FAILED = 'FAILED',
}

interface ReconnectConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

class MediaNode extends EventEmitter {
  id: string;
  private ip: string;
  private grpcPort: string | number;
  private address: string;
  private grpcClient: MediaSignalingClient | null;
  private grpcCall: grpc.ClientDuplexStream<
    MessageRequest,
    MessageResponse__Output
  > | null;
  private static mediaNodes = new Map<string, MediaNode>();

  private connectionState: ConnectionState;
  private reconnectAttempts: number;
  private reconnectTimer: NodeJS.Timeout | null;
  private healthCheckTimer: NodeJS.Timeout | null;
  private readonly reconnectConfig: ReconnectConfig;
  private readonly clientId: string;
  private isShuttingDown: boolean;

  constructor({
    id,
    ip = '0.0.0.0',
    address,
    grpcPort = 50052,
    grpcClient,
    grpcCall,
    reconnectConfig = {
      maxRetries: 10,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
    },
  }: {
    id: string;
    ip: string;
    address: string;
    grpcPort?: string | number;
    grpcClient: MediaSignalingClient;
    grpcCall: grpc.ClientDuplexStream<MessageRequest, MessageResponse__Output>;
    reconnectConfig?: Partial<ReconnectConfig>;
  }) {
    super();
    this.id = id;
    this.ip = ip;
    this.address = address;
    this.grpcPort = grpcPort;
    this.grpcClient = grpcClient;
    this.grpcCall = grpcCall;

    this.connectionState = ConnectionState.DISCONNECTED;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.clientId = config.nodeId;
    this.isShuttingDown = false;

    this.reconnectConfig = {
      maxRetries: 10,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      ...reconnectConfig,
    };

    MediaNode.mediaNodes.set(this.id, this);

    this.handleMessages();
  }

  static connectToRunningNodes = async (): Promise<void> => {
    try {
      const redisData = await redisServer.sMembers(
        getRedisKey['medianodesRunning']()
      );
      if (!redisData.length) return;

      const connectionPromises = redisData.map(data => {
        try {
          const mediaNodesData: MediaNodeData = JSON.parse(data);

          const grpcClient =
            new protoDescriptor.mediaSignalingPackage.MediaSignaling(
              `${mediaNodesData.ip}:${mediaNodesData.grpcPort}`,
              grpc.credentials.createInsecure(),
              {
                'grpc.keepalive_time_ms': 10000,
                'grpc.keepalive_timeout_ms': 5000,
                'grpc.keepalive_permit_without_calls': 1,
                'grpc.http2.max_pings_without_data': 0,
                'grpc.http2.min_time_between_pings_ms': 10000,
                'grpc.http2.min_ping_interval_without_data_ms': 300000,
              }
            );

          // Wait for client to be ready with timeout
          const deadline = new Date();
          deadline.setMilliseconds(deadline.getMilliseconds() + 15000);

          grpcClient.waitForReady(deadline, error => {
            if (error) {
              throw error;
            } else {
              console.log('GRPC Connection Ready');
            }
          });
          // Establish bidirectional stream
          const metadata = new grpc.Metadata();
          metadata.set('clientId', config.nodeId);
          const grpcCall = grpcClient.message(metadata);

          return new MediaNode({
            ...mediaNodesData,
            grpcClient,
            grpcCall,
          });
        } catch (parseError) {
          console.error(`Failed to parse media node data: ${data}`, parseError);
          return null;
        }
      });

      await Promise.allSettled(connectionPromises);
    } catch (error) {
      console.error('Error connecting to running nodes:', error);
      throw error;
    }
  };

  get isConnected(): boolean {
    return this.connectionState === ConnectionState.CONNECTED;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  private setState(newState: ConnectionState): void {
    if (this.connectionState !== newState) {
      const oldState = this.connectionState;
      this.connectionState = newState;
      this.emit('stateChanged', { oldState, newState, nodeId: this.id });
      console.log(
        `MediaNode ${this.id} state changed: ${oldState} -> ${newState}`
      );
    }
  }

  private calculateReconnectDelay(): number {
    const delay = Math.min(
      this.reconnectConfig.initialDelay *
        Math.pow(
          this.reconnectConfig.backoffMultiplier,
          this.reconnectAttempts
        ),
      this.reconnectConfig.maxDelay
    );
    return delay + Math.random() * 1000; // Add jitter
  }

  private setupHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      if (this.isConnected && this.grpcCall) {
        try {
          // Send a ping message to check connection health
          this.grpcCall.write({
            action: 'ping',
            args: JSON.stringify({ timestamp: Date.now() }),
          });
        } catch (error) {
          console.warn(`Health check failed for node ${this.id}:`, error);
          this.handleConnectionError(error as Error);
        }
      }
    }, 30000); // Health check every 30 seconds
  }

  private handleConnectionError(error: Error): void {
    console.error(`Connection error for MediaNode ${this.id}:`, error);
    this.setState(ConnectionState.DISCONNECTED);
    this.emit('connectionError', { error, nodeId: this.id });

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.reconnectConfig.maxRetries) {
      console.error(
        `Max reconnection attempts (${this.reconnectConfig.maxRetries}) reached for node ${this.id}`
      );
      this.setState(ConnectionState.FAILED);
      this.emit('connectionFailed', { nodeId: this.id });
      return;
    }

    const delay = this.calculateReconnectDelay();
    console.log(
      `Scheduling reconnection attempt ${this.reconnectAttempts + 1} for node ${this.id} in ${delay}ms`
    );

    this.setState(ConnectionState.RECONNECTING);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      // this.connect();
    }, delay);
  }

  sendMessage(action: MSA, args?: { [key: string]: unknown }): boolean {
    if (!this.grpcCall) return false;
    try {
      this.grpcCall.write({
        action,
        args: JSON.stringify(args || {}),
      });
      return true;
    } catch (error) {
      console.error(` Error sending message to client ${this.id}:`, error);
      return false;
    }
  }

  private handleMessages(): void {
    if (!this.grpcCall) return;
    // Handle incoming messages

    this.grpcCall.on('data', (message: MessageRequest) => {
      const { action, args } = message;
      if (!action) return;
      const handler = this.actionHandlers[action as MSA];

      if (handler) handler(args && JSON.parse(args));
    });

    // Handle client disconnection
    this.grpcCall.on('end', () => {
      console.log(`Client ${this.id} ended the connection`);
      // close connection
    });

    this.grpcCall.on('error', (error: Error) => {
      console.error(`Stream error for MediaNode ${this.id}:`, error);
      this.handleConnectionError(error);
    });

    this.grpcCall.on('close', () => {
      console.log(`Stream closed for MediaNode ${this.id}`);
      if (this.connectionState === ConnectionState.CONNECTED) {
        this.handleConnectionError(new Error('Stream closed unexpectedly'));
      }
    });

    this.sendMessage(MSA.Connected, {
      status: 'success',
      nodeId: this.id,
      message: 'Successfully connected to Media Signaling Server',
    });
  }

  // Static methods for managing all nodes
  static getNode(id: string): MediaNode | undefined {
    return MediaNode.mediaNodes.get(id);
  }

  static getAllNodes(): MediaNode[] {
    return Array.from(MediaNode.mediaNodes.values());
  }

  static getConnectedNodes(): MediaNode[] {
    return Array.from(MediaNode.mediaNodes.values()).filter(
      node => node.isConnected
    );
  }

  static getConnectionStats(): { [key: string]: number } {
    const stats: { [key: string]: number } = {};
    Object.values(ConnectionState).forEach(state => {
      stats[state] = 0;
    });

    MediaNode.mediaNodes.forEach(node => {
      stats[node.connectionState]++;
    });

    return stats;
  }

  private actionHandlers: {
    [key in MSA]?: (args: { [key: string]: unknown }) => void;
  } = {
    connected: args => {
      console.log(args);
    },
  };
}

export default MediaNode;

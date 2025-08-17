import { EventEmitter } from 'stream';
import path from 'path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { redisServer } from '../servers/redis-server';
import { getRedisKey } from '../lib/utils';
import { MediaNodeData } from '../types';
import { ProtoGrpcType } from '../protos/gen/media-signaling';
import { MediaSignalingClient } from '../protos/gen/mediaSignalingPackage/MediaSignaling';
import { SendMessageRequest } from '../protos/gen/mediaSignalingPackage/SendMessageRequest';
import { SendMessageResponse__Output } from '../protos/gen/mediaSignalingPackage/SendMessageResponse';

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
  private grpcCall:
    | grpc.ClientDuplexStream<SendMessageRequest, SendMessageResponse__Output>
    | undefined;
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
    reconnectConfig?: Partial<ReconnectConfig>;
  }) {
    super();
    this.id = id;
    this.ip = ip;
    this.address = address;
    this.grpcPort = grpcPort;
    this.grpcClient = null;
    this.grpcCall = undefined;

    this.connectionState = ConnectionState.DISCONNECTED;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.clientId = crypto.randomUUID();
    this.isShuttingDown = false;

    this.reconnectConfig = {
      maxRetries: 10,
      initialDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      ...reconnectConfig,
    };

    MediaNode.mediaNodes.set(this.id, this);
    this.connect();
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
          return new MediaNode(mediaNodesData);
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

  private cleanup(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.grpcCall) {
      try {
        this.grpcCall.removeAllListeners();
        this.grpcCall.end();
      } catch (error) {
        console.warn(`Error ending gRPC call for node ${this.id}:`, error);
      }
      this.grpcCall = undefined;
    }

    if (this.grpcClient) {
      try {
        this.grpcClient.close();
      } catch (error) {
        console.warn(`Error closing gRPC client for node ${this.id}:`, error);
      }
      this.grpcClient = null;
    }
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
            type: 'ping',
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
      this.connect();
    }, delay);
  }

  async connect(): Promise<void> {
    if (this.isShuttingDown) {
      console.log(
        `Node ${this.id} is shutting down, skipping connection attempt`
      );
      return;
    }

    if (this.connectionState === ConnectionState.CONNECTING) {
      console.log(`Connection already in progress for node ${this.id}`);
      return;
    }

    this.setState(ConnectionState.CONNECTING);
    this.cleanup(); // Clean up any existing connections

    try {
      // Create gRPC client with proper options
      this.grpcClient =
        new protoDescriptor.mediaSignalingPackage.MediaSignaling(
          `${this.ip}:${this.grpcPort}`,
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
      await this.waitForClientReady(15000);

      // Establish bidirectional stream
      const metadata = new grpc.Metadata();
      metadata.set('clientId', this.clientId);
      metadata.set('nodeId', this.id);

      this.grpcCall = this.grpcClient.SendMessage(metadata);
      this.setupStreamHandlers();

      // Send initial connection message
      this.grpcCall.write({
        type: 'connect',
        args: JSON.stringify({
          status: 'success',
          nodeId: this.id,
          timestamp: Date.now().toString(),
        }),
      });

      this.setState(ConnectionState.CONNECTED);
      this.reconnectAttempts = 0;
      this.setupHealthCheck();
      this.emit('connected', { nodeId: this.id });

      console.log(
        `Successfully connected to gRPC server for node ${this.id} at ${this.ip}:${this.grpcPort}`
      );
    } catch (error) {
      console.error(
        `Failed to connect to gRPC server for node ${this.id}:`,
        error
      );
      this.handleConnectionError(error as Error);
    }
  }

  private waitForClientReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.grpcClient) {
        reject(new Error('gRPC client is null'));
        return;
      }

      const deadline = new Date();
      deadline.setMilliseconds(deadline.getMilliseconds() + timeoutMs);

      this.grpcClient.waitForReady(deadline, error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private setupStreamHandlers(): void {
    if (!this.grpcCall) return;

    this.grpcCall.on('data', (chunk: SendMessageResponse__Output) => {
      console.log(`Received data from MediaNode ${this.id}:`, chunk);
      this.emit('message', { data: chunk, nodeId: this.id });

      // Handle pong responses for health checks
      if (chunk.type === 'pong') {
        console.log(`Health check pong received from node ${this.id}`);
      }
    });

    this.grpcCall.on('end', () => {
      console.log(`Stream ended for MediaNode ${this.id}`);
      this.handleConnectionError(new Error('Stream ended'));
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
  }

  async sendMessage(message: SendMessageRequest): Promise<boolean> {
    if (!this.isConnected || !this.grpcCall) {
      console.warn(
        `Cannot send message to MediaNode ${this.id}: not connected`
      );
      this.emit('sendError', {
        error: new Error('Not connected'),
        message,
        nodeId: this.id,
      });
      return false;
    }

    try {
      this.grpcCall.write(message);
      return true;
    } catch (error) {
      console.error(`Error sending message to MediaNode ${this.id}:`, error);
      this.emit('sendError', { error, message, nodeId: this.id });
      this.handleConnectionError(error as Error);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    console.log(`Disconnecting MediaNode ${this.id}`);
    this.isShuttingDown = true;

    // Send disconnect message if connected
    if (this.isConnected && this.grpcCall) {
      try {
        this.grpcCall.write({
          type: 'disconnect',
          args: JSON.stringify({
            reason: 'client_disconnect',
            timestamp: Date.now().toString(),
          }),
        });

        // Give some time for the message to be sent
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.warn(
          `Error sending disconnect message for node ${this.id}:`,
          error
        );
      }
    }

    this.cleanup();
    this.setState(ConnectionState.DISCONNECTED);
    MediaNode.mediaNodes.delete(this.id);
    this.emit('disconnected', { nodeId: this.id });
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

  static async disconnectAll(): Promise<void> {
    const nodes = Array.from(MediaNode.mediaNodes.values());
    await Promise.all(nodes.map(node => node.disconnect()));
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
}

export default MediaNode;

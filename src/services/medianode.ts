import { EventEmitter } from 'stream';
import path from 'path';
import { types as mediasoupTypes } from 'mediasoup';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { ioRedisServer } from '../servers/ioredis-server';
import { parseArguments as parseArguments } from '../lib/utils';
import { PendingRequest, ResponseData } from '../types';
import { ProtoGrpcType } from '../protos/gen/media-signaling';
import { MediaSignalingClient } from '../protos/gen/mediaSignalingPackage/MediaSignaling';
import { MessageRequest } from '../protos/gen/mediaSignalingPackage/MessageRequest';
import { MessageResponse } from '../protos/gen/mediaSignalingPackage/MessageResponse';
import config from '../config';
import { Actions } from '../types/actions';
import { ValidationSchema } from '../lib/schema';
import Room from './room';

const PROTO_FILE = path.resolve(__dirname, '../protos/media-signaling.proto');
const packageDefinition = protoLoader.loadSync(PROTO_FILE, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const protoDescriptor = grpc.loadPackageDefinition(
  packageDefinition
) as unknown as ProtoGrpcType;

class MediaNode extends EventEmitter {
  id: string;
  private ip: string;
  private grpcPort: string | number;
  private grpcClient: MediaSignalingClient | null;
  private grpcCall: grpc.ClientDuplexStream<
    MessageRequest,
    MessageResponse
  > | null;
  private routerRtpCapabilities: mediasoupTypes.RtpCapabilities | null;

  private reconnectTimer: NodeJS.Timeout | null;
  private healthCheckTimer: NodeJS.Timeout | null;
  private connectionTimeout: NodeJS.Timeout | null;
  private circuitBreakerTimer: NodeJS.Timeout | null;

  private reconnectAttempts: number = 0;
  private isReconnecting: boolean = false;
  private lastHeartbeatAck: number = Date.now();

  private readonly clientId: string;
  private readonly connectionId: string;

  private readonly maxQueueSize: number = 1000;
  private readonly messageTimeout: number = 30000;

  // implemented to get immediate response to request/stream
  private pendingRequests: Map<string, PendingRequest>;
  private static mediaNodes = new Map<string, MediaNode>();
  private static roundRobinIndex = 0;

  constructor({
    id,
    ip = '0.0.0.0',
    grpcPort = 50052,
  }: {
    id: string;
    ip: string;
    grpcPort?: string | number;
  }) {
    super();
    this.id = id;
    this.ip = ip;
    this.grpcPort = grpcPort;
    this.grpcClient = null;
    this.grpcCall = null;

    this.routerRtpCapabilities = null;

    this.pendingRequests = new Map();

    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.connectionTimeout = null;
    this.circuitBreakerTimer = null;

    this.clientId = config.nodeId;
    this.connectionId = this.generateConnectionId();
  }

  getRouterRtpCapabilities(): mediasoupTypes.RtpCapabilities | null {
    return this.routerRtpCapabilities;
  }

  private generateConnectionId(): string {
    return `${this.clientId}_${this.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  static async getRunningMediaNodes(): Promise<
    { [key: string]: string | number }[]
  > {
    console.log('getRunningMediaNodes');
    let cursor = 0;
    const medianodeKeys: string[] = [];

    do {
      const scanResult = await ioRedisServer.scan(cursor, {
        MATCH: `medianodes:*`,
        COUNT: 10,
      });
      medianodeKeys.push(...scanResult.keys);
      cursor = parseInt(scanResult.cursor);
    } while (cursor !== 0);

    const hashPromise = medianodeKeys.map(key => ioRedisServer.hGetAll(key));
    const mediaNodesData = await Promise.all(hashPromise);
    console.log({ mediaNodesData });
    return mediaNodesData;
  }

  static async connectToRunningNodes(): Promise<MediaNode[]> {
    const mediaNodeData = await MediaNode.getRunningMediaNodes();
    // return;

    if (!mediaNodeData.length) {
      console.log('No running media nodes found in Redis');
      return [];
    }
    const connectionPromises = mediaNodeData.map(async medianode => {
      const data = ValidationSchema.mediaNodeAdded.parse(medianode);

      new MediaNode(data).connect().catch(error => {
        console.error(`Failed to connect to MediaNode ${data.id}:`, error);
      });
    });

    const results = await Promise.allSettled(connectionPromises);
    const nodes: MediaNode[] = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value) {
        nodes.push(result.value);
      } else if (result.status === 'rejected') {
        console.error(
          `Failed to create connection to node ${index}:`,
          result.reason
        );
      }
    });

    console.log(`Created ${nodes.length} media node connections`);
    return nodes;
  }

  async connect(): Promise<void> {
    // this.cleanup(); // Clean up any existing connections
    // check if instance already exists
    let isExistingNode = false;
    if (MediaNode.mediaNodes.has(this.id)) {
      console.log(
        `MediaNode connection instance with id ${this.id} already exists. close old connection .`
      );
      isExistingNode = true;

      await MediaNode.mediaNodes.get(this.id)?.disconnect();
    }

    // Set connection timeout
    const connectionPromise = this.establishConnection();
    const timeoutPromise = new Promise<never>((_, reject) => {
      this.connectionTimeout = setTimeout(() => {
        reject(new Error(`Connection timeout after 15 seconds`));
      }, 15000);
    });

    await Promise.race([connectionPromise, timeoutPromise]);

    // Clear connection timeout on success
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }

    // Reset reconnection state on successful connect
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    // store instance
    MediaNode.mediaNodes.set(this.id, this);

    // Send initial connection message
    this.sendMessage(Actions.Connected, {
      status: 'success',
      nodeId: this.clientId,
      connectionId: this.connectionId,
      timestamp: Date.now(),
      message: 'Successfully connected to Media Signaling Server',
    });

    // Start health-check heartbeat
    this.setupHealthCheck();

    console.log(
      `Successfully ${isExistingNode ? 'reconnected' : 'connected'} to MediaNode ${this.id} at ${this.ip}:${this.grpcPort}`
    );
  }

  async disconnect(): Promise<void> {
    this.cleanup();
    MediaNode.mediaNodes.delete(this.id);
    console.log(`Disconnected from MediaNode ${this.id}`);
  }

  static async disconnectById(id: string): Promise<void> {
    const node = MediaNode.mediaNodes.get(id);
    if (node) {
      await node.disconnect();
      console.log(`Disconnected from MediaNode ${id}`);
    } else {
      console.warn(`No MediaNode found with id ${id} to disconnect`);
    }
  }

  // Todo
  // update functionality to get and compare medianode server metrics
  // Consider storing server metrics in redis and not instances
  static getleastLoadedNode(): MediaNode | null {
    const nodes = Array.from(MediaNode.mediaNodes.values());
    if (nodes.length === 0) return null;

    // Round-robin distribution across available nodes
    const selectedNode = nodes[MediaNode.roundRobinIndex % nodes.length];
    MediaNode.roundRobinIndex = (MediaNode.roundRobinIndex + 1) % nodes.length;

    return selectedNode;
  }

  private cleanup(): void {
    try {
      console.log(`Cleaning up MediaNode ${this.id} connections and timers`);

      // Clear all timers
      this.clearTimers();

      this.pendingRequests.forEach(({ reject }) => {
        reject(new Error('MediaNode disconnected, request cancelled'));
      });
      this.pendingRequests.clear();

      // Close gRPC call
      if (this.grpcCall) {
        this.grpcCall.end();
        this.grpcCall = null;
      }

      if (this.grpcClient) {
        this.grpcClient.close();
        this.grpcClient = null;
      }
    } catch (error) {
      console.error(`Error during cleanup of MediaNode ${this.id}:`, error);
    }
  }

  private clearTimers(): void {
    const timers = [
      { timer: this.reconnectTimer, name: 'reconnect' },
      { timer: this.healthCheckTimer, name: 'healthCheck' },
      { timer: this.connectionTimeout, name: 'connectionTimeout' },
      { timer: this.circuitBreakerTimer, name: 'circuitBreaker' },
    ];

    timers.forEach(({ timer, name }) => {
      if (timer) {
        clearTimeout(timer);
        console.log(`🧹 Cleared ${name} timer for node ${this.id}`);
      }
    });

    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.connectionTimeout = null;
    this.circuitBreakerTimer = null;
  }

  private async establishConnection(): Promise<void> {
    // Create gRPC client with proper options
    this.grpcClient = new protoDescriptor.mediaSignalingPackage.MediaSignaling(
      `${this.ip}:${this.grpcPort}`,
      grpc.credentials.createInsecure(),
      {
        'grpc.keepalive_time_ms': 30000,
        'grpc.keepalive_timeout_ms': 10000,
        'grpc.keepalive_permit_without_calls': 1,
        'grpc.http2.min_time_between_pings_ms': 30000,
        'grpc.http2.max_pings_without_data': 0,
      }
    );

    // Wait for client to be ready
    await this.waitForClientReady(10000);

    // Establish bidirectional stream
    const metadata = new grpc.Metadata();
    metadata.set('clientid', this.clientId);
    metadata.set('nodeId', this.id);
    metadata.set('connectionId', this.connectionId);
    metadata.set('timestamp', Date.now().toString());

    this.grpcCall = this.grpcClient.message(metadata);
    this.setupMessageHandlers();

    // Wait for initial connection confirmation
    await this.waitForConnectionConfirmation();
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
          reject(new Error(`gRPC client not ready: ${error.message}`));
        } else {
          console.log(`gRPC client ready for node ${this.id}`);
          resolve();
        }
      });
    });
  }

  private waitForConnectionConfirmation(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection confirmation timeout'));
      }, 5000);

      const onConfirmation = (): void => {
        console.log('Got confirmation');
        clearTimeout(timeout);
        this.off('connectionConfirmed', onConfirmation);
        resolve();
      };

      this.on('connectionConfirmed', onConfirmation);
    });
  }

  // Message handling
  sendMessage(action: Actions, args?: { [key: string]: unknown }): void {
    if (!this.grpcCall) {
      throw `Cannot send message to MediaNode ${this.id}: not connected`;
    }
    const message = {
      action,
      args: JSON.stringify(args || {}),
    };
    this.grpcCall.write(message);
  }

  async sendMessageForResponse(
    action: Actions,
    args?: { [key: string]: unknown }
  ): Promise<ResponseData> {
    if (!this.grpcCall) {
      throw `Cannot send message to MediaNode ${this.id}: not connected`;
    }

    // Check queue size to prevent memory exhaustion
    if (this.pendingRequests.size >= this.maxQueueSize) {
      return Promise.reject(
        new Error(
          `Pending request queue full (${this.maxQueueSize}). MediaNode ${this.id} may be overloaded.`
        )
      );
    }

    const requestId = crypto.randomUUID();

    const message: MessageRequest = {
      action,
      args: JSON.stringify(args || {}),
      requestId,
    };

    return new Promise<ResponseData>((resolve, reject) => {
      if (this.grpcCall) {
        // Set timeout to prevent orphaned requests
        const timeout = setTimeout(() => {
          const pendingRequest = this.pendingRequests.get(requestId);
          if (pendingRequest) {
            this.pendingRequests.delete(requestId);
            reject(
              new Error(
                `Request timeout after ${this.messageTimeout}ms for action ${action} to MediaNode ${this.id}`
              )
            );
          }
        }, this.messageTimeout);

        this.pendingRequests.set(requestId, {
          resolve,
          reject,
          timeout,
        });

        this.grpcCall.write(message);
      }
    });
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  private setupMessageHandlers(): void {
    if (!this.grpcCall) return;

    // Handle incoming messages
    this.grpcCall.on('data', (message: MessageResponse) => {
      this.handleIncomingMessage(message);
    });

    // Handle connection events — all trigger reconnection
    this.grpcCall.on('end', () => {
      console.log(`MediaNode ${this.id} ended the connection`);
      this.handleStreamDisconnect('stream_ended');
    });

    this.grpcCall.on('error', (error: Error) => {
      console.error(`Stream error for MediaNode ${this.id}:`, error);
      this.handleStreamDisconnect('stream_error');
    });

    this.grpcCall.on('close', () => {
      console.log(`Stream closed for MediaNode ${this.id}`);
      this.handleStreamDisconnect('stream_closed');
    });

    this.grpcCall.on('cancelled', () => {
      console.log(`Stream cancelled for MediaNode ${this.id}`);
      this.handleStreamDisconnect('stream_cancelled');
    });
  }

  private handleStreamDisconnect(reason: string): void {
    if (this.isReconnecting) return;
    console.warn(
      `MediaNode ${this.id} disconnected: ${reason} — scheduling reconnect`
    );
    this.cleanup();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.isReconnecting = true;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(
      `Reconnecting to MediaNode ${this.id} in ${delay}ms (attempt ${this.reconnectAttempts + 1})`
    );
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        console.log(`MediaNode ${this.id} reconnected successfully`);
      } catch (error) {
        console.error(
          `Reconnect attempt ${this.reconnectAttempts + 1} failed for MediaNode ${this.id}:`,
          error
        );
        this.reconnectAttempts++;
        this.scheduleReconnect();
      }
    }, delay);
  }

  private setupHealthCheck(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.lastHeartbeatAck = Date.now();
    this.healthCheckTimer = setInterval(() => {
      if (!this.grpcCall) return;
      const staleness = Date.now() - this.lastHeartbeatAck;
      if (staleness > 60000) {
        console.warn(
          `MediaNode ${this.id} heartbeat timeout (${staleness}ms) — reconnecting`
        );
        this.handleStreamDisconnect('heartbeat_timeout');
        return;
      }
      try {
        this.sendMessage(Actions.Heartbeat, {
          timestamp: Date.now(),
          connectionId: this.connectionId,
        });
      } catch (error) {
        console.warn(
          `Failed to send heartbeat to MediaNode ${this.id}:`,
          error
        );
      }
    }, 30000);
  }

  private handleHeartbeat(args: { [key: string]: unknown }): void {
    console.log(args);
    this.lastHeartbeatAck = Date.now();
    // Respond to heartbeat
    this.sendMessage(Actions.HeartbeatAck, {
      timestamp: Date.now(),
      connectionId: this.connectionId,
    });
  }

  sendResponse(
    action: Actions,
    requestId: string,
    response: { [key: string]: unknown }
  ): void {
    if (!this.grpcCall) {
      throw `Cannot send message to MediaNode ${this.id}: not connected`;
    }
    const message: MessageRequest = {
      action,
      requestId,
      args: JSON.stringify({
        status: 'success',
        response,
      }),
    };

    this.grpcCall.write(message);
  }
  sendError(action: Actions, requestId: string, error: Error | unknown): void {
    if (!this.grpcCall) {
      throw `Cannot send message to MediaNode ${this.id}: not connected`;
    }
    const message: MessageRequest = {
      action,
      requestId,
      args: JSON.stringify({
        status: 'error',
        error,
      }),
    };

    this.grpcCall.write(message);
  }

  // Static methods for managing all nodes
  static getNode(id: string): MediaNode | undefined {
    return MediaNode.mediaNodes.get(id);
  }

  static getAllNodes(): MediaNode[] {
    return Array.from(MediaNode.mediaNodes.values());
  }

  private handleIncomingMessage(message: MessageResponse): void {
    const { action, args, requestId } = message;
    if (!action) return;

    const parsedArgs = parseArguments(args);

    if (requestId?.length) {
      const pendingRequest = this.pendingRequests.get(requestId);
      if (pendingRequest) {
        // Clear timeout if it exists
        if (pendingRequest.timeout) {
          clearTimeout(pendingRequest.timeout);
        }

        if (parsedArgs.status === 'error') {
          pendingRequest.reject(parsedArgs.error as Error);
        } else {
          const response = parsedArgs.response as { [key: string]: unknown };
          pendingRequest.resolve(response);
        }
        this.pendingRequests.delete(requestId);
        return;
      }
    }

    // Find and execute handler
    const handler = this.actionHandlers[action as Actions];
    if (handler) {
      handler(parsedArgs, requestId).catch(error => {
        console.error('Error =>', action, error);
      });
    } else {
      console.warn(`No handler for action ${action} from ${this.id}`);
    }
  }

  // Action handlers for different message types
  private actionHandlers: {
    [key in Actions]?: (
      args: { [key: string]: unknown },
      requestId?: string
    ) => Promise<void>;
  } = {
    [Actions.Connected]: async args => {
      this.emit('connectionConfirmed');
      this.routerRtpCapabilities =
        args.routerRtpCapabilities as mediasoupTypes.RtpCapabilities;
    },

    [Actions.Heartbeat]: async args => {
      this.handleHeartbeat(args);
    },

    [Actions.HeartbeatAck]: async () => {
      this.lastHeartbeatAck = Date.now();
    },

    [Actions.ConsumerCreated]: async (args, requestId) => {
      const { peerId, roomId } =
        ValidationSchema.createConsumerData.parse(args);
      const room = Room.getRoom(roomId);
      const peer = room?.getPeer(peerId);
      if (!peer) throw `No room or peer found`;

      peer.sendMessage({
        message: {
          action: Actions.ConsumerCreated,
          args,
        },
        callback: res => {
          if (res.status === 'error') {
            console.log(res.error);
            peer
              .getMedianode()
              .sendError(
                Actions.ConsumerCreated,
                requestId as string,
                new Error(res.error as string)
              );
          } else {
            console.log(
              'Callback for createConsumer called by cleint successfully'
            );
            peer
              .getMedianode()
              .sendResponse(Actions.ConsumerCreated, requestId as string, {});
          }
        },
      });
    },

    [Actions.ConsumerPaused]: async args => {
      console.log(Actions.ConsumerPaused);
      const { peerId, roomId } = ValidationSchema.ConsumerStateData.parse(args);
      const room = Room.getRoom(roomId);
      const peer = room?.getPeer(peerId);
      if (!peer) throw `No room or peer found`;
      peer.sendMessage({
        message: {
          action: Actions.ConsumerPaused,
          args,
        },
      });
      console.log(Actions.ConsumerPaused);
    },

    [Actions.ConsumerResumed]: async args => {
      console.log(args, 'consumer');
      const { peerId, roomId } = ValidationSchema.ConsumerStateData.parse(args);
      const room = Room.getRoom(roomId);
      const peer = room?.getPeer(peerId);
      if (!peer) throw `No room or peer found`;
      peer.sendMessage({
        message: {
          action: Actions.ConsumerResumed,
          args,
        },
      });
      console.log(Actions.ConsumerResumed);
    },

    [Actions.ConsumerClosed]: async args => {
      console.log(args, 'consumer');
      const { peerId, roomId } = ValidationSchema.ConsumerStateData.parse(args);
      const room = Room.getRoom(roomId);
      const peer = room?.getPeer(peerId);
      if (!peer) throw `No room or peer found`;
      peer.sendMessage({
        message: {
          action: Actions.ConsumerClosed,
          args,
        },
      });
      console.log(Actions.ConsumerClosed);
    },

    // Add more handlers as needed for your specific actions
  };
}

export default MediaNode;

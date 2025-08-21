import { EventEmitter } from 'stream';
import path from 'path';
import { types as mediasoupTypes } from 'mediasoup';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { redisServer } from '../servers/redis-server';
import { getRedisKey, parseArgs } from '../lib/utils';
import { MediaNodeData } from '../types';
import { ProtoGrpcType } from '../protos/gen/media-signaling';
import { MediaSignalingClient } from '../protos/gen/mediaSignalingPackage/MediaSignaling';
import { MessageRequest } from '../protos/gen/mediaSignalingPackage/MessageRequest';
import { MessageResponse } from '../protos/gen/mediaSignalingPackage/MessageResponse';
import config from '../config';
import { Actions as MSA } from '../types/actions';

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

enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  FAILED = 'FAILED',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
}

interface ReconnectConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitterMax: number;
  resetTimeout: number;
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeout: number;
  monitoringPeriod: number;
}

interface ConnectionMetrics {
  connectedAt?: Date;
  lastActivity: Date;
  lastSuccessfulMessage: Date;
  messagesSent: number;
  messagesReceived: number;
  reconnectCount: number;
  consecutiveFailures: number;
  totalFailures: number;
  lastError?: Error;
  circuitBreakerTrips: number;
}

interface QueuedMessage {
  action: MSA;
  args?: { [key: string]: unknown };
  timestamp: number;
  retries: number;
  id: string;
}

class MediaNode extends EventEmitter {
  id: string;
  private ip: string;
  private grpcPort: string | number;
  private address: string;
  private grpcClient: MediaSignalingClient | null;
  private grpcCall: grpc.ClientDuplexStream<
    MessageRequest,
    MessageResponse
  > | null;
  private routerRtpCapabilities: mediasoupTypes.RtpCapabilities | null;

  private connectionState: ConnectionState;
  private reconnectAttempts: number;
  private reconnectTimer: NodeJS.Timeout | null;
  private healthCheckTimer: NodeJS.Timeout | null;
  private connectionTimeout: NodeJS.Timeout | null;
  private circuitBreakerTimer: NodeJS.Timeout | null;

  private readonly reconnectConfig: ReconnectConfig;
  private readonly circuitBreakerConfig: CircuitBreakerConfig;
  private readonly clientId: string;
  private readonly connectionId: string;

  private isShuttingDown: boolean;
  private metrics: ConnectionMetrics;
  private messageQueue: QueuedMessage[] = [];
  private readonly maxQueueSize: number = 1000;
  private readonly messageTimeout: number = 30000;

  // implemented to get immediate response to request/stream
  private pendingRequests: Map<string, (response: MessageResponse) => void>;
  private static mediaNodes = new Map<string, MediaNode>();

  constructor({
    id,
    ip = '0.0.0.0',
    address,
    grpcPort = 50052,
    reconnectConfig = {},
    circuitBreakerConfig = {},
  }: {
    id: string;
    ip: string;
    address: string;
    grpcPort?: string | number;
    reconnectConfig?: Partial<ReconnectConfig>;
    circuitBreakerConfig?: Partial<CircuitBreakerConfig>;
  }) {
    super();
    this.id = id;
    this.ip = ip;
    this.address = address;
    this.grpcPort = grpcPort;
    this.grpcClient = null;
    this.grpcCall = null;

    this.routerRtpCapabilities = null;

    this.pendingRequests = new Map();

    this.connectionState = ConnectionState.DISCONNECTED;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.healthCheckTimer = null;
    this.connectionTimeout = null;
    this.circuitBreakerTimer = null;

    this.clientId = config.nodeId;
    this.connectionId = this.generateConnectionId();
    this.isShuttingDown = false;

    this.reconnectConfig = {
      maxRetries: 20,
      initialDelay: 1000,
      maxDelay: 60000,
      backoffMultiplier: 1.5,
      jitterMax: 1000,
      resetTimeout: 300000, // 5 minutes
      ...reconnectConfig,
    };

    this.circuitBreakerConfig = {
      failureThreshold: 5,
      successThreshold: 3,
      timeout: 60000, // 1 minute
      monitoringPeriod: 30000, // 30 seconds
      ...circuitBreakerConfig,
    };

    const now = new Date();
    this.metrics = {
      lastActivity: now,
      lastSuccessfulMessage: now,
      messagesSent: 0,
      messagesReceived: 0,
      reconnectCount: 0,
      consecutiveFailures: 0,
      totalFailures: 0,
      circuitBreakerTrips: 0,
    };

    // Handle existing connection with same ID
    if (MediaNode.mediaNodes.has(this.id)) {
      console.warn(
        `⚠️  MediaNode with ID ${this.id} already exists, disconnecting old instance`
      );
      const oldNode = MediaNode.mediaNodes.get(this.id);
      oldNode?.disconnect().catch(console.error);
    }

    MediaNode.mediaNodes.set(this.id, this);

    // Start connection process
    this.connect().catch(error => {
      console.error(`❌ Initial connection failed for node ${this.id}:`, error);
    });
  }

  private generateConnectionId(): string {
    return `${this.clientId}_${this.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  static async connectToRunningNodes(): Promise<MediaNode[]> {
    try {
      const redisData = await redisServer.sMembers(
        getRedisKey['medianodesRunning']()
      );

      if (!redisData.length) {
        console.log('📭 No running media nodes found in Redis');
        return [];
      }

      console.log(
        `🔍 Found ${redisData.length} running media nodes, connecting...`
      );

      const connectionPromises = redisData.map(async data => {
        try {
          const mediaNodesData: MediaNodeData = JSON.parse(data);

          console.log(
            `🔄 Creating connection to node ${mediaNodesData.id} at ${mediaNodesData.ip}:${mediaNodesData.grpcPort}`
          );
          return new MediaNode(mediaNodesData);
        } catch (parseError) {
          console.error(
            `❌ Failed to parse media node data: ${data}`,
            parseError
          );
          return null;
        }
      });

      const results = await Promise.allSettled(connectionPromises);
      const nodes: MediaNode[] = [];

      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          nodes.push(result.value);
        } else if (result.status === 'rejected') {
          console.error(
            `❌ Failed to create connection to node ${index}:`,
            result.reason
          );
        }
      });

      console.log(`✅ Created ${nodes.length} media node connections`);
      return nodes;
    } catch (error) {
      console.error('❌ Error connecting to running nodes:', error);
      throw error;
    }
  }

  // Getters
  get isConnected(): boolean {
    return this.connectionState === ConnectionState.CONNECTED;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get connectionMetrics(): ConnectionMetrics {
    return { ...this.metrics };
  }

  get queueSize(): number {
    return this.messageQueue.length;
  }

  getRouterRtpCapabilities(): mediasoupTypes.RtpCapabilities | null {
    return this.routerRtpCapabilities;
  }

  // Todo
  // update functionality to get and compare medianode server metrics
  // Consider storing server metrics in redis and not instances
  static getleastLoadedNode(): MediaNode | null {
    const nodes = Array.from(MediaNode.mediaNodes.values());
    if (nodes.length) return nodes[0];
    return null;
  }

  // State management
  private setState(newState: ConnectionState): void {
    if (this.connectionState !== newState) {
      const oldState = this.connectionState;
      this.connectionState = newState;

      console.log(`📡 MediaNode ${this.id} state: ${oldState} -> ${newState}`);
      this.emit('stateChanged', {
        nodeId: this.id,
        oldState,
        newState,
        timestamp: new Date(),
        metrics: this.getConnectionMetrics(),
      });

      // Reset consecutive failures on successful connection
      if (newState === ConnectionState.CONNECTED) {
        this.metrics.consecutiveFailures = 0;
        this.metrics.connectedAt = new Date();
      }
    }
  }

  // Circuit breaker pattern
  private shouldAttemptConnection(): boolean {
    if (this.connectionState === ConnectionState.CIRCUIT_OPEN) {
      return false;
    }

    if (
      this.metrics.consecutiveFailures >=
      this.circuitBreakerConfig.failureThreshold
    ) {
      this.openCircuitBreaker();
      return false;
    }

    return true;
  }

  private openCircuitBreaker(): void {
    console.warn(
      `🔴 Circuit breaker opened for node ${this.id} (${this.metrics.consecutiveFailures} consecutive failures)`
    );
    this.setState(ConnectionState.CIRCUIT_OPEN);
    this.metrics.circuitBreakerTrips++;

    // Set timer to attempt connection after timeout
    if (this.circuitBreakerTimer) {
      clearTimeout(this.circuitBreakerTimer);
    }

    this.circuitBreakerTimer = setTimeout(() => {
      console.log(
        `🟡 Circuit breaker half-open for node ${this.id}, attempting reconnection`
      );
      this.setState(ConnectionState.DISCONNECTED);
      this.connect().catch(error => {
        console.error(
          `❌ Circuit breaker reconnection failed for node ${this.id}:`,
          error
        );
      });
    }, this.circuitBreakerConfig.timeout);
  }

  // Connection management
  private calculateReconnectDelay(): number {
    const baseDelay = Math.min(
      this.reconnectConfig.initialDelay *
        Math.pow(
          this.reconnectConfig.backoffMultiplier,
          this.reconnectAttempts
        ),
      this.reconnectConfig.maxDelay
    );

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * this.reconnectConfig.jitterMax;
    return baseDelay + jitter;
  }

  private cleanup(): void {
    console.log(`🧹 Cleaning up MediaNode ${this.id} connections and timers`);

    // Clear all timers
    this.clearTimers();

    // Close gRPC call
    if (this.grpcCall) {
      try {
        this.grpcCall.removeAllListeners();
        this.grpcCall.cancel();
        this.grpcCall = null;
      } catch (error) {
        console.warn(
          `⚠️  Error cancelling gRPC call for node ${this.id}:`,
          error
        );
      }
    }

    // Close gRPC client
    if (this.grpcClient) {
      try {
        this.grpcClient.close();
        this.grpcClient = null;
      } catch (error) {
        console.warn(
          `⚠️  Error closing gRPC client for node ${this.id}:`,
          error
        );
      }
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

  private setupHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    this.healthCheckTimer = setInterval(() => {
      if (this.isConnected && this.grpcCall) {
        try {
          // Send ping to verify connection health
          this.sendMessage(MSA.Ping, {
            timestamp: Date.now(),
            connectionId: this.connectionId,
          });

          const pingResponse = this.sendMessageForResponse(MSA.Ping, {
            timestamp: Date.now(),
            connectionId: this.connectionId,
          });

          console.log('Got response from message', { pingResponse });
        } catch (error) {
          console.warn(`💔 Health check failed for node ${this.id}:`, error);
          this.handleConnectionError(error as Error, 'health_check_failed');
        }
      }
    }, 30000); // Health check every 30 seconds
  }

  private handleConnectionError(
    error: Error,
    context: string = 'unknown'
  ): void {
    console.error(
      `💥 Connection error for MediaNode ${this.id} [${context}]:`,
      error.message
    );

    this.metrics.lastError = error;
    this.metrics.totalFailures++;
    this.metrics.consecutiveFailures++;

    this.setState(ConnectionState.DISCONNECTED);
    this.emit('connectionError', {
      nodeId: this.id,
      error,
      context,
      consecutiveFailures: this.metrics.consecutiveFailures,
      timestamp: new Date(),
    });

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldAttemptConnection()) {
      return;
    }

    if (this.reconnectAttempts >= this.reconnectConfig.maxRetries) {
      console.error(
        `🚫 Max reconnection attempts (${this.reconnectConfig.maxRetries}) reached for node ${this.id}`
      );
      this.setState(ConnectionState.FAILED);
      this.emit('connectionFailed', {
        nodeId: this.id,
        attempts: this.reconnectAttempts,
        timestamp: new Date(),
      });
      return;
    }

    const delay = this.calculateReconnectDelay();
    console.log(
      `⏰ Scheduling reconnection attempt ${this.reconnectAttempts + 1}/${this.reconnectConfig.maxRetries} for node ${this.id} in ${Math.round(delay)}ms`
    );

    this.setState(ConnectionState.RECONNECTING);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.metrics.reconnectCount++;
      this.connect().catch(error => {
        console.error(
          `❌ Scheduled reconnection failed for node ${this.id}:`,
          error
        );
      });
    }, delay);
  }

  async connect(): Promise<void> {
    if (this.isShuttingDown) {
      console.log(
        `🛑 Node ${this.id} is shutting down, skipping connection attempt`
      );
      return;
    }

    if (this.connectionState === ConnectionState.CONNECTING) {
      console.log(`⏳ Connection already in progress for node ${this.id}`);
      return;
    }

    if (!this.shouldAttemptConnection()) {
      console.log(
        `🔴 Circuit breaker prevents connection attempt for node ${this.id}`
      );
      return;
    }

    this.setState(ConnectionState.CONNECTING);
    this.cleanup(); // Clean up any existing connections

    try {
      console.log(
        `🔌 Connecting to MediaNode ${this.id} at ${this.ip}:${this.grpcPort} (attempt ${this.reconnectAttempts + 1})`
      );

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

      this.setState(ConnectionState.CONNECTED);
      this.reconnectAttempts = 0;
      this.setupHealthCheck();
      this.flushMessageQueue();

      this.emit('connected', {
        nodeId: this.id,
        connectionId: this.connectionId,
        address: `${this.ip}:${this.grpcPort}`,
        timestamp: new Date(),
      });

      // Send initial connection message
      this.sendMessage(MSA.Connected, {
        status: 'success',
        nodeId: this.clientId,
        connectionId: this.connectionId,
        timestamp: Date.now(),
        message: 'Successfully connected to Media Signaling Server',
      });

      console.log(
        `✅ Successfully connected to MediaNode ${this.id} at ${this.ip}:${this.grpcPort}`
      );
    } catch (error) {
      console.error(`❌ Failed to connect to MediaNode ${this.id}:`, error);
      this.handleConnectionError(error as Error, 'connection_failed');
    }
  }

  private async establishConnection(): Promise<void> {
    // Create gRPC client with proper options
    this.grpcClient = new protoDescriptor.mediaSignalingPackage.MediaSignaling(
      `${this.ip}:${this.grpcPort}`,
      grpc.credentials.createInsecure(),
      {
        'grpc.keepalive_time_ms': 10000,
        'grpc.keepalive_timeout_ms': 5000,
        'grpc.keepalive_permit_without_calls': 1,
        'grpc.http2.max_pings_without_data': 0,
        'grpc.http2.min_time_between_pings_ms': 10000,
        'grpc.http2.min_ping_interval_without_data_ms': 300000,
        'grpc.max_receive_message_length': 4 * 1024 * 1024, // 4MB
        'grpc.max_send_message_length': 4 * 1024 * 1024, // 4MB
        'grpc.initial_reconnect_backoff_ms': 1000,
        'grpc.max_reconnect_backoff_ms': 10000,
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
          console.log(`🎯 gRPC client ready for node ${this.id}`);
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
        clearTimeout(timeout);
        this.off('connectionConfirmed', onConfirmation);
        resolve();
      };

      this.on('connectionConfirmed', onConfirmation);
    });
  }

  // Message handling
  sendMessage(action: MSA, args?: { [key: string]: unknown }): boolean {
    if (!this.grpcCall) {
      console.warn(
        `⚠️  Cannot send message to MediaNode ${this.id}: not connected`
      );
      return false;
    }

    try {
      const message = {
        action,
        args: JSON.stringify(args || {}),
      };

      this.grpcCall.write(message);

      console.log(`📤 Sent ${action} to MediaNode ${this.id}`);

      return true;
    } catch (error) {
      console.error(`❌ Error sending message to MediaNode ${this.id}:`, error);
      this.handleConnectionError(error as Error, 'send_message_error');
      return false;
    }
  }

  async sendMessageForResponse(
    action: MSA,
    args?: { [key: string]: unknown }
  ): Promise<MessageResponse | null> {
    if (!this.grpcCall) {
      console.warn(
        `⚠️  Cannot send message to MediaNode ${this.id}: not connected`
      );
      return null;
    }

    try {
      const requestId = crypto.randomUUID();

      const message: MessageRequest = {
        action,
        args: JSON.stringify(args || {}),
        requestId,
      };

      return new Promise<MessageResponse>(resolve => {
        if (this.grpcCall) {
          this.pendingRequests.set(requestId, resolve); // save resolve
          this.grpcCall.write(message);
        }
      });
    } catch (error) {
      console.error(`❌ Error sending message to MediaNode ${this.id}:`, error);
      throw error;
    }
  }

  queueMessage(action: MSA, args?: { [key: string]: unknown }): boolean {
    if (this.messageQueue.length >= this.maxQueueSize) {
      console.warn(
        `⚠️  Message queue full for ${this.id} (${this.maxQueueSize}), dropping oldest message`
      );
      this.messageQueue.shift();
    }

    const queuedMessage: QueuedMessage = {
      action,
      args,
      timestamp: Date.now(),
      retries: 0,
      id: this.generateMessageId(),
    };

    this.messageQueue.push(queuedMessage);
    console.log(
      `📝 Queued message ${action} for ${this.id} (queue: ${this.messageQueue.length}/${this.maxQueueSize})`
    );

    this.emit('messageQueued', {
      nodeId: this.id,
      action,
      queueSize: this.messageQueue.length,
      timestamp: new Date(),
    });

    return true;
  }

  private flushMessageQueue(): void {
    if (!this.isConnected || this.messageQueue.length === 0) {
      return;
    }

    console.log(
      `📤 Flushing ${this.messageQueue.length} queued messages for ${this.id}`
    );

    const messages = [...this.messageQueue];
    this.messageQueue = [];
    let sentCount = 0;
    let failedCount = 0;

    messages.forEach(message => {
      if (this.sendMessage(message.action, message.args)) {
        sentCount++;
      } else {
        // Re-queue failed messages if under retry limit
        if (message.retries < 3) {
          message.retries++;
          this.messageQueue.push(message);
        } else {
          failedCount++;
          console.warn(
            `⚠️  Dropping message ${message.action} after ${message.retries} retries`
          );
        }
      }
    });

    console.log(
      `📤 Queue flush complete for ${this.id}: ${sentCount} sent, ${failedCount} dropped, ${this.messageQueue.length} re-queued`
    );
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

    // Handle connection events
    this.grpcCall.on('end', () => {
      console.log(`📤 MediaNode ${this.id} ended the connection`);
      this.handleConnectionError(
        new Error('Connection ended by remote'),
        'remote_end'
      );
    });

    this.grpcCall.on('error', (error: Error) => {
      console.error(`💥 Stream error for MediaNode ${this.id}:`, error);
      this.handleConnectionError(error, 'stream_error');
    });

    this.grpcCall.on('close', () => {
      console.log(`🔌 Stream closed for MediaNode ${this.id}`);
      if (this.connectionState === ConnectionState.CONNECTED) {
        this.handleConnectionError(
          new Error('Stream closed unexpectedly'),
          'unexpected_close'
        );
      }
    });

    this.grpcCall.on('cancelled', () => {
      console.log(`🚫 Stream cancelled for MediaNode ${this.id}`);
      this.handleConnectionError(
        new Error('Stream cancelled'),
        'stream_cancelled'
      );
    });
  }

  private handleIncomingMessage(message: MessageResponse): void {
    try {
      this.metrics.messagesReceived++;
      this.metrics.lastActivity = new Date();
      this.metrics.lastSuccessfulMessage = new Date();

      const { action, args, requestId } = message;

      if (requestId?.length) {
        const resolver = this.pendingRequests.get(requestId);
        if (resolver) {
          // this means this instance initiated this request for response .
          // resolve and return
          resolver(message);
          this.pendingRequests.delete(requestId);
          return;
        }
      }

      if (!action) {
        console.warn(`⚠️  Received message without action from ${this.id}`);
        return;
      }

      console.log(`📨 Received message from MediaNode ${this.id}: ${action}`);

      const parsedArgs = parseArgs(args);
      // Handle system messages
      if (action === MSA.Heartbeat) {
        this.handleHeartbeat(parsedArgs);
        return;
      }

      if (action === MSA.ServerShutdown) {
        this.handleServerShutdown(parsedArgs);
        return;
      }

      // Find and execute handler
      const handler = this.actionHandlers[action as MSA];
      if (handler) {
        try {
          handler(parsedArgs, requestId);
        } catch (handlerError) {
          console.error(
            `❌ Error in handler for action ${action} from ${this.id}:`,
            handlerError
          );
        }
      } else {
        console.warn(`⚠️  No handler for action ${action} from ${this.id}`);
        this.emit('unhandledMessage', {
          nodeId: this.id,
          action,
          args: parsedArgs,
        });
      }

      this.emit('messageReceived', {
        nodeId: this.id,
        action,
        args: parsedArgs,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error(`💥 Error handling message from ${this.id}:`, error);
      this.metrics.totalFailures++;
    }
  }

  private handleHeartbeat(args: { [key: string]: unknown }): void {
    console.log(args);
    // Respond to heartbeat
    this.sendMessage(MSA.HeartbeatAck, {
      timestamp: Date.now(),
      connectionId: this.connectionId,
      metrics: {
        messagesSent: this.metrics.messagesSent,
        messagesReceived: this.metrics.messagesReceived,
        queueSize: this.messageQueue.length,
        uptime: this.metrics.connectedAt
          ? Date.now() - this.metrics.connectedAt.getTime()
          : 0,
      },
    });
  }

  private handleServerShutdown(args: { [key: string]: unknown }): void {
    console.log(`📢 Server shutdown notification from ${this.id}:`, args);
    this.emit('serverShutdown', { nodeId: this.id, args });

    // Don't attempt to reconnect immediately after server shutdown
    this.setState(ConnectionState.DISCONNECTED);
    this.scheduleReconnect();
  }

  // Connection lifecycle
  async disconnect(): Promise<void> {
    console.log(`👋 Disconnecting MediaNode ${this.id}`);
    this.isShuttingDown = true;

    // Send disconnect message if connected
    if (this.isConnected) {
      try {
        this.sendMessage(MSA.Disconnect, {
          reason: 'client_disconnect',
          connectionId: this.connectionId,
          timestamp: Date.now(),
        });

        // Give time for the message to be sent
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.warn(
          `⚠️  Error sending disconnect message for node ${this.id}:`,
          error
        );
      }
    }

    this.cleanup();
    this.setState(ConnectionState.DISCONNECTED);
    MediaNode.mediaNodes.delete(this.id);

    this.emit('disconnected', {
      nodeId: this.id,
      metrics: this.getConnectionMetrics(),
      timestamp: new Date(),
    });
  }

  forceDisconnect(reason: string = 'force_disconnect'): void {
    console.log(`💥 Force disconnecting MediaNode ${this.id} (${reason})`);
    this.isShuttingDown = true;
    this.cleanup();
    this.setState(ConnectionState.DISCONNECTED);
    MediaNode.mediaNodes.delete(this.id);
  }

  // Utility methods
  getConnectionMetrics(): ConnectionMetrics {
    return { ...this.metrics };
  }

  getDetailedStatus(): {
    id: string;
    connectionId: string;
    state: ConnectionState;
    address: string;
    isConnected: boolean;
    uptime: number;
    queueSize: number;
    metrics: ConnectionMetrics;
    reconnectAttempts: number;
  } {
    return {
      id: this.id,
      connectionId: this.connectionId,
      state: this.connectionState,
      address: `${this.ip}:${this.grpcPort}`,
      isConnected: this.isConnected,
      uptime: this.metrics.connectedAt
        ? Date.now() - this.metrics.connectedAt.getTime()
        : 0,
      queueSize: this.messageQueue.length,
      metrics: this.getConnectionMetrics(),
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // Action handlers for different message types
  private actionHandlers: {
    [key in MSA]?: (
      args: { [key: string]: unknown },
      requestId?: string
    ) => void;
  } = {
    [MSA.Connected]: args => {
      console.log(`✅ Connection confirmed from node ${this.id}:`, args);
      this.emit('connectionConfirmed', { nodeId: this.id, args });
      this.routerRtpCapabilities =
        args.routerRtpCapabilities as mediasoupTypes.RtpCapabilities;
    },

    [MSA.Heartbeat]: args => {
      this.handleHeartbeat(args);
    },

    [MSA.HeartbeatAck]: args => {
      console.log(`💗 Heartbeat acknowledged by ${this.id}`, args);
      this.metrics.lastActivity = new Date();
    },

    [MSA.ServerShutdown]: args => {
      this.handleServerShutdown(args);
    },

    // Add more handlers as needed for your specific actions
  };

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

  static getNodesByState(state: ConnectionState): MediaNode[] {
    return Array.from(MediaNode.mediaNodes.values()).filter(
      node => node.connectionState === state
    );
  }

  static async disconnectAll(): Promise<void> {
    console.log(
      `🛑 Disconnecting all ${MediaNode.mediaNodes.size} media nodes...`
    );

    const nodes = Array.from(MediaNode.mediaNodes.values());
    const disconnectPromises = nodes.map(node =>
      node.disconnect().catch(error => {
        console.warn(`⚠️  Error disconnecting node ${node.id}:`, error);
        node.forceDisconnect('disconnect_all_force');
      })
    );

    await Promise.allSettled(disconnectPromises);
    MediaNode.mediaNodes.clear();
    console.log('✅ All media nodes disconnected');
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

  static getDetailedStats(): {
    totalNodes: number;
    connectionStats: { [key: string]: number };
    totalMessagesSent: number;
    totalMessagesReceived: number;
    totalReconnects: number;
    totalQueuedMessages: number;
    nodes: Array<{
      id: string;
      state: ConnectionState;
      metrics: ConnectionMetrics;
      isConnected: boolean;
      queueSize: number;
      uptime: number;
    }>;
  } {
    const nodes = Array.from(MediaNode.mediaNodes.values());

    return {
      totalNodes: nodes.length,
      connectionStats: MediaNode.getConnectionStats(),
      totalMessagesSent: nodes.reduce(
        (sum, node) => sum + node.metrics.messagesSent,
        0
      ),
      totalMessagesReceived: nodes.reduce(
        (sum, node) => sum + node.metrics.messagesReceived,
        0
      ),
      totalReconnects: nodes.reduce(
        (sum, node) => sum + node.metrics.reconnectCount,
        0
      ),
      totalQueuedMessages: nodes.reduce(
        (sum, node) => sum + node.messageQueue.length,
        0
      ),
      nodes: nodes.map(node => ({
        id: node.id,
        state: node.connectionState,
        metrics: node.connectionMetrics,
        isConnected: node.isConnected,
        queueSize: node.queueSize,
        uptime: node.metrics.connectedAt
          ? Date.now() - node.metrics.connectedAt.getTime()
          : 0,
      })),
    };
  }

  static broadcastMessage(
    action: MSA,
    args?: { [key: string]: unknown },
    options?: {
      excludeNodeId?: string;
      onlyConnected?: boolean;
      queueIfDisconnected?: boolean;
    }
  ): { sent: number; queued: number; failed: number } {
    const opts = {
      onlyConnected: true,
      queueIfDisconnected: false,
      ...options,
    };

    let nodes = Array.from(MediaNode.mediaNodes.values());

    if (opts.excludeNodeId) {
      nodes = nodes.filter(node => node.id !== opts.excludeNodeId);
    }

    let sent = 0;
    let queued = 0;
    let failed = 0;

    nodes.forEach(node => {
      if (node.isConnected) {
        if (node.sendMessage(action, args)) {
          sent++;
        } else {
          failed++;
        }
      } else if (opts.queueIfDisconnected) {
        if (node.queueMessage(action, args)) {
          queued++;
        } else {
          failed++;
        }
      } else if (!opts.onlyConnected) {
        failed++;
      }
    });

    console.log(
      `📢 Broadcast ${action}: ${sent} sent, ${queued} queued, ${failed} failed`
    );
    return { sent, queued, failed };
  }

  static async reconnectAll(): Promise<void> {
    console.log('🔄 Reconnecting all disconnected media nodes...');

    const disconnectedNodes = MediaNode.getNodesByState(
      ConnectionState.DISCONNECTED
    ).concat(MediaNode.getNodesByState(ConnectionState.FAILED));

    const reconnectPromises = disconnectedNodes.map(node =>
      node.connect().catch(error => {
        console.warn(`⚠️  Error reconnecting node ${node.id}:`, error);
      })
    );

    await Promise.allSettled(reconnectPromises);
    console.log(
      `✅ Reconnection attempts completed for ${disconnectedNodes.length} nodes`
    );
  }
}

export default MediaNode;
export { ConnectionState, MediaNode };

import { EventEmitter } from 'stream';
import path from 'path';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { MediaSignalingClient } from '../protos/media_signaling_package/MediaSignaling';
import { ProtoGrpcType } from '../protos/media-signaling';
import { SendMessageRequest } from '../protos/media_signaling_package/SendMessageRequest';
import { SendMessageResponse__Output } from '../protos/media_signaling_package/SendMessageResponse';

const PROTO_FILE = path.resolve(__dirname, '../protos/media-signaling.proto');
const packageDefinition = protoLoader.loadSync(PROTO_FILE);
const protoDescriptor = grpc.loadPackageDefinition(
  packageDefinition
) as unknown as ProtoGrpcType;

class MediaNode extends EventEmitter {
  id: string;
  private ip: string;
  private grpcPort: string | number;
  private host: string;
  private grpcClient: MediaSignalingClient | null;
  private grpcCall:
    | grpc.ClientDuplexStream<SendMessageRequest, SendMessageResponse__Output>
    | undefined;
  private static mediaNodes = new Map<string, MediaNode>();
  isConnected: boolean;
  constructor({
    id,
    ip = '0.0.0.0',
    host,
    grpcPort = 50052,
  }: {
    id: string;
    ip: string;
    host: string;
    grpcPort?: string | number;
  }) {
    super();
    this.id = id;
    this.ip = ip;
    this.host = host;
    this.grpcPort = grpcPort;
    this.grpcClient = null;
    this.isConnected = false;
    MediaNode.mediaNodes.set(this.id, this);

    this.connect();
  }

  connect(): void {
    this.grpcClient =
      new protoDescriptor.media_signaling_package.MediaSignaling(
        `${this.ip}:${this.grpcPort}`,
        grpc.credentials.createInsecure()
      );
    const deadline = new Date();
    deadline.setSeconds(deadline.getSeconds() + 5);

    this.grpcClient.waitForReady(deadline, error => {
      if (error) {
        console.error(error);
        throw error;
      }
      this.isConnected = true;
      console.log('Connected to grpc server');
      const metadata = new grpc.Metadata();
      metadata.set('clientId', crypto.randomUUID());
      this.grpcCall = this.grpcClient?.SendMessage(metadata);

      this.grpcCall?.on('data', chunk => {
        console.log('Got chunk from server');
        console.log(chunk);
      });

      this.grpcCall?.write({
        type: 'connect',
        args: {
          status: 'success',
        },
      });
    });
  }
}

export default MediaNode;

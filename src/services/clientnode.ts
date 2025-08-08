import EventEmitter from 'events';
import { Socket } from 'socket.io';
// import ClientNodeHandler from '../handlers/clientnode-handler';
import { ServiceEvents, SignallingEvents } from '../types/events';
import { AckCallback, MessageData } from '../types/interfaces';
import Lobby from './lobby';
import Visitor from './visitor';

class ClientNode extends EventEmitter {
  connectionId: string;
  connection: Socket;
  closed: boolean;

  static clientNodes = new Map<string, ClientNode>();

  constructor(connection: Socket) {
    super();
    this.connectionId = connection.id;
    this.connection = connection;
    this.closed = false;

    ClientNode.clientNodes.set(this.connectionId, this);
    this.handleConnections();
    console.info(
      'clientnode connected with connectionId - ',
      this.connectionId
    );
  }

  handleConnections(): void {
    this.connection.on('connect_error', error => {
      console.error('client connection error', error);
    });
    this.connection.on('disconnect', error => {
      console.info('client connection disconnect', error);
    });
    this.connection.on(
      'message',
      (data: MessageData, callback: AckCallback) => {
        const { event, args } = data;
        const handler = this.eventHandlers[event as SignallingEvents];
        if (handler) handler(args, callback);
      }
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.disconnect(true);
    ClientNode.clientNodes.delete(this.connectionId);
    this.emit(ServiceEvents.Close);
    this.removeAllListeners();
  }

  private eventHandlers: {
    [key in SignallingEvents]?: (
      args?: { [key: string]: unknown },
      callback?: AckCallback
    ) => void;
  } = {
    'join-visitors': (args, callback) => {
      const { roomId, peerId } = args as { roomId: string; peerId: string };
      const lobby = Lobby.getLobby(roomId) || new Lobby({ roomId });
      const visitor = new Visitor({
        peerId,
        roomId,
        connection: this.connection,
      });
      lobby.addVisitor(visitor);
      this.connection.join(`lobby-${roomId}`);

      console.log(args);
      if (callback)
        callback({
          status: 'success',
        });
    },

    'join-waiters': (args, callback) => {
      console.log('join-waiters');
      console.log(args);
      if (callback)
        callback({
          status: 'error',
        });
    },

    'get-room-status': (args, callback) => {
      console.log('join-room');
      console.log(args);
      if (callback)
        callback({
          status: 'error',
        });
    },

    'get-rtp-capabilities': (args, callback) => {
      console.log('join-room');
      console.log(args);
      if (callback)
        callback({
          status: 'error',
        });
    },

    'join-room': (args, callback) => {
      console.log('join-room');
      console.log(args);
      if (callback)
        callback({
          status: 'error',
        });
    },
  };
}
export default ClientNode;

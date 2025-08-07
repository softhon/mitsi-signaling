import EventEmitter from 'events';
import { Socket } from 'socket.io';
// import ClientNodeHandler from '../handlers/clientnode-handler';
import { ServiceEvents, SignallingEvents } from '../types/events';
import { AckCallback, MessageData } from '../types/interfaces';

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
      args?: unknown,
      callback?: AckCallback
    ) => void;
  } = {
    'join-lobby': (args, callback) => {
      console.log('join-lobby');
      console.log(args);
      if (callback)
        callback({
          status: 'success',
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

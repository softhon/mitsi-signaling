import EventEmitter from 'events';
import { Socket } from 'socket.io';
import ClientNodeConnection from '../connections/clientnode-connection';
import { ServiceEvents } from '../types/events';

class ClientNode extends EventEmitter {
  connectionId: string;
  connection: Socket;
  closed: boolean;
  private connectionHandler: ClientNodeConnection;

  static clientNodes = new Map<string, ClientNode>();

  constructor(connection: Socket) {
    super();
    this.connectionId = connection.id;
    this.connection = connection;
    this.closed = false;

    this.connectionHandler = new ClientNodeConnection(this);
    ClientNode.clientNodes.set(this.connectionId, this);

    console.info('ClientNode connected');
  }

  close = () => {
    if (this.closed) return;
    this.closed = true;
    this.connectionHandler.cleanup();
    this.connection.disconnect(true);
    ClientNode.clientNodes.delete(this.connectionId);
    this.emit(ServiceEvents.Close);
    this.removeAllListeners();
  };
}
export default ClientNode;

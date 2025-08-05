import ClientNode from '../services/clientnode-service';

class ClientNodeConnection {
  private clientNode: ClientNode | null;

  constructor(clientNode: ClientNode) {
    this.clientNode = clientNode;
    this.listen();
  }

  private listen = () => {
    if (!this.clientNode) return;
    this.clientNode.connection.on('connect_error', error => {
      console.log('ClientNode connection error', error);
    });
    this.clientNode.connection.on('disconnect', error => {
      console.log('ClientNode connection error', error);
    });
    this.clientNode.connection.on('mesaage', () => {});
  };

  cleanup = () => {
    if (this.clientNode) {
      this.clientNode.connection.removeAllListeners();
      this.clientNode = null;
    }
  };
}
export default ClientNodeConnection;

import EventEmitter from 'events';
import { Socket } from 'socket.io';
import { AckCallback, MessageData } from '../types';
import { Actions } from '../types/actions';
import { getRedisKey } from '../lib/utils';

abstract class Base extends EventEmitter {
  id: string;
  roomId: string;
  peerId: string;
  connection: Socket;
  closed: boolean;

  constructor({
    roomId,
    peerId,
    connection,
  }: {
    roomId: string;
    peerId: string;
    connection: Socket;
  }) {
    super();
    this.id = peerId;
    this.peerId = peerId;
    this.roomId = roomId;
    this.connection = connection;
    this.closed = false;
  }

  close(silent?: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.emit(Actions.Close, { silent });
    this.removeAllListeners();
    console.log('Peer', 'Close peer');
  }

  message({
    message,
    broadcast,
    includeMe,
    callback,
  }: {
    message: MessageData;
    broadcast?: boolean;
    includeMe?: boolean;
    callback?: AckCallback;
  }): void {
    if (broadcast) {
      this.connection.broadcast
        .to(getRedisKey['room'](this.roomId))
        .emit(Actions.Message, message);
      if (includeMe) {
        this.connection.emit(Actions.Message, message);
      }
    } else {
      this.connection.emit(Actions.Message, message, callback);
    }
  }
}

export default Base;

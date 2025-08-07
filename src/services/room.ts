import EventEmitter from 'events';
import Peer from './peer';

class Room extends EventEmitter {
  roomId: string;
  hostId: string;
  coHostEmails: string[];
  started: number;
  maxDuration: number;
  maxPeers: number; //
  allowRecording: boolean;
  allowWaiting: boolean;
  timeLeft: number;

  selfDestructTimeout: NodeJS.Timeout | null;
  endCountDownInterval: NodeJS.Timeout | null;

  private peers: Map<string, Peer>;
  recorder: Peer | null;

  closed: boolean;

  static rooms = new Map<string, Room>();

  constructor({
    roomId,
    hostId,
    coHostEmails,
    started,
    maxDuration,
    maxPeers,
    allowRecording,
    allowWaiting,
  }: {
    roomId: string;
    hostId: string;
    coHostEmails: string[];
    started: number;
    maxDuration: number;
    maxPeers: number;
    allowRecording: boolean;
    allowWaiting: boolean;
  }) {
    super();
    this.roomId = roomId;
    this.hostId = hostId;
    this.coHostEmails = coHostEmails;
    this.started = started;
    this.maxDuration = maxDuration;
    this.maxPeers = maxPeers;
    this.allowRecording = allowRecording;
    this.allowWaiting = allowWaiting;
    this.timeLeft = Math.round(
      (started + maxDuration * 60 * 1000 - Date.now()) / (1000 * 60)
    );
    this.peers = new Map();

    this.selfDestructTimeout = null;
    this.endCountDownInterval = null;

    this.recorder = null;
    this.closed = true;
  }
}

export default Room;

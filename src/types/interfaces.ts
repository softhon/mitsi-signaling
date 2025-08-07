export type ProducerSource = 'mic' | 'camera' | 'screen' | 'screenAudio';

export type TransportKind = 'producer' | 'consumer';
export type AckCallback<T = unknown> = (res: {
  status: 'success' | 'error';
  error?: Error | null;
  response?: T;
}) => void;
export type PeerType = 'Recorder' | 'Attendee';

export enum Role {
  Moderator = 'MODERATOR',
  Speaker = 'SPEAKER',
  Attendee = 'ATTENDEE',
}

export enum Tag {
  Host = 'Host',
  Cohost = 'Co-host',
  Moderator = 'Moderator',
  Speaker = 'Speaker',
  Pinned = 'Pinned',
  Attendee = 'Attendee',
}

export enum HTTPSTATUS {
  OK = 200,
  CREATED = 201,
  BAD_REQUEST = 400,
  UNAUTHORISED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  CONFLICT = 409,
  INTERNAL_SERVER_ERROR = 500,
}

export interface MessageData {
  event: string;
  args: unknown;
}

export interface RoomData {
  id: string;
  title: string;
  meetingId: string;
  description: string;
  hostUser: {
    id: string;
    name: string;
  };
  coHostUserEmails: string[];
  guestUserEmails: string[];
  allowWaiting?: boolean;
}

export interface PeerData {
  id: string;
  userId?: string;
  name: string;
  email?: string;
  photo?: string;
  color?: string;
  isMobileDevice?: boolean;
  jobTitle?: string;
  isRejoining?: boolean;
  isRecorder?: boolean;
  roles?: Role[];
  tag?: Tag;
  pinned?: boolean;
  online?: boolean;
}

export interface AttendeeData {
  id: string;
  name: string;
  userId?: string;
  photo?: string;
  color?: string;
  email?: string;
  info?: string;
  joined: number;
}

export interface ChatData {
  id: string;
  text: string;
  sender: PeerData;
  receiver: PeerData;
  isFile?: boolean;
  isPinned?: boolean;
  createdAt: number;
}

export interface MediaNodeData {
  id: string;
  ip: string;
  host: string;
}

export interface Reaction {
  id: string;
  name: string;
  peerId: string;
  peerName: string;
  position: `${number}%`;
  timestamp: number;
}

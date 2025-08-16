import { redisServer } from '../servers/redis-server';
import { SignalnodeData } from '../types/interfaces';

export const getRedisKey = {
  room: (roomId: string): string => `room-${roomId}`,
  lobby: (roomId: string): string => `lobby-${roomId}`,
  roomPeers: (roomId: string): string => `room-${roomId}-peers`,
  roomPeerIds: (roomId: string): string => `room-${roomId}-peerids`,
  roomActiveSpeakerPeerId: (roomId: string): string =>
    `room-${roomId}-activespeakerpeerid`,
  roomsOngoing: (): string => `rooms-ongoing`,
  medianodesRunning: (): string => `medianodes-running`,
  signalnodesRunning: (): string => `signalnodes-running`,
  roomMedianodes: (roomId: string): string => `room-${roomId}-medianodes`,
  roomSignalnodes: (roomId: string): string => `room-${roomId}-signalnodes`,
};

export const registerNode = async (
  signalnode: SignalnodeData
): Promise<void> => {
  try {
    await redisServer.sAdd(
      getRedisKey['signalnodesRunning'](),
      JSON.stringify(signalnode)
    );
  } catch (error) {
    console.log(error);
  }
};

import config from '../config';
import { redisServer } from '../servers/redis-server';
import { SignalnodeData } from '../types';

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

export const registerSignalNode = async (): Promise<SignalnodeData> => {
  try {
    const { publicIpv4 } = await import('public-ip');
    const ip = await publicIpv4();
    const signalnodeData: SignalnodeData = {
      id: ip || config.nodeId,
      ip,
      address: `${config.port}`,
    };
    await redisServer.sAdd(
      getRedisKey['signalnodesRunning'](),
      JSON.stringify(signalnodeData)
    );
    return signalnodeData;
  } catch (error) {
    throw error;
  }
};

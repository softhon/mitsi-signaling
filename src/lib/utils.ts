import config from '../config';
import { redisServer } from '../servers/redis-server';
import { SignalnodeData } from '../types';

export const getRedisKey = {
  room: (roomId: string): string => `room:${roomId}`,
  lobby: (roomId: string): string => `lobby:${roomId}`,
  roomPeers: (roomId: string): string => `room:${roomId}:peers`,
  roomPeerIds: (roomId: string): string => `room:${roomId}:peerids`,
  roomActiveSpeakerPeerId: (roomId: string): string =>
    `room:${roomId}:activespeakerpeerid`,
  rooms: (): string => `rooms`,
  medianodes: (): string => `medianodes`,
  signalnodes: (): string => `signalnodes`,
  roomMedianodes: (roomId: string): string => `room:${roomId}:medianodes`,
  roomSignalnodes: (roomId: string): string => `room:${roomId}:signalnodes`,
};

export const getPubSubChannel = {
  room: (roomId: string): string => `room-${roomId}`,
};

export const registerSignalNode = async (): Promise<SignalnodeData> => {
  try {
    const { publicIpv4 } = await import('public-ip');
    const ip = await publicIpv4();
    const signalnodeData: SignalnodeData = {
      id: config.nodeId,
      ip,
      address: `${config.port}`,
    };
    await redisServer.sAdd(
      getRedisKey['signalnodes'](),
      JSON.stringify(signalnodeData)
    );
    return signalnodeData;
  } catch (error) {
    throw error;
  }
};

export const parseArgs = (args?: string): { [key: string]: unknown } => {
  let parsedArgs: { [key: string]: unknown } = {};
  if (args) {
    try {
      parsedArgs = JSON.parse(args);
    } catch (parseError) {
      throw parseError;
    }
  }
  return parsedArgs;
};

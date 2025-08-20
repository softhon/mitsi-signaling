import z from 'zod';
import { Role, Tag } from '../types';

const peerDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  userId: z.string().optional(),
  email: z.string().optional(),
  photo: z.string().optional(),
  color: z.string().optional(),
  isMobileDevice: z.boolean().optional(),
  jobTitle: z.string().optional(),
  isRejoining: z.boolean().optional(),
  isRecorder: z.boolean().optional(),
  hand: z
    .object({
      raised: z.boolean(),
      timestamp: z.number().optional(),
    })
    .optional(),
  roles: z
    .array(z.enum(Object.values(Role) as [string, ...string[]]))
    .optional(),
  tag: z.enum(Object.values(Tag) as [string, ...string[]]).optional(),
  pinned: z.boolean().optional(),
  online: z.boolean().optional(),
  joined: z.number().optional(),
  reconnecting: z.boolean().optional(),
});

// Infer TypeScript type from schema for type safety
// type PeerDataFromSchema = z.infer<typeof peerDataSchema>;

const roomIdPeerIdSchema = z.object({
  roomId: z.string(),
  peerId: z.string(),
});

export const ValidationSchema = {
  peerId: z.object({
    peerId: z.string(),
  }),

  roomId: z.object({
    roomId: z.string(),
  }),

  roomIdPeerId: roomIdPeerIdSchema,

  roomIdPeerIdPeerData: z.object({
    roomId: z.string(),
    peerId: z.string(),
    peerData: peerDataSchema,
  }),

  joinMeeting: z.object({
    roomId: z.string(),
    peerData: peerDataSchema,
    deviceRtpCapabilities: z.any(),
  }),
};

export const MidialSignalingSchema = {
  connected: z.object({
    status: z.enum(['SUCCESS', 'FAILED']),
    nodeId: z.string(),
    connectionId: z.string(),
    message: z.string(),
    timestamp: z.number(),
    serverMetrics: z.any(),
    routerRtpCapabilities: z.any(),
  }),
};

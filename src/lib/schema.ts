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

const producerSource = z.enum(['mic', 'camera', 'screen', 'screenAudio']);
const mediaKind = z.enum(['audio', 'video']);

export const ValidationSchema = {
  peerId: z.object({
    peerId: z.string(),
  }),

  roomId: z.object({
    roomId: z.string(),
  }),

  peerIds: z.object({
    peerIds: z.array(z.string()),
  }),

  roomIdPeerId: roomIdPeerIdSchema,

  roomIdPeerIdPeerData: roomIdPeerIdSchema.extend({
    peerData: peerDataSchema,
  }),

  joinMeeting: z.object({
    roomId: z.string(),
    peerData: peerDataSchema,
    deviceRtpCapabilities: z
      .any()
      .refine(value => value, 'Can not be null or undefined'),
  }),

  connectWebRtcTransport: z.object({
    transportId: z.string(),
    dtlsParameters: z.any(),
  }),

  createConsumerData: roomIdPeerIdSchema.extend({
    id: z.string(),
    producerId: z.string(),
    transportId: z.string(),
    producerPeerId: z.string(),
    producerSource: producerSource,
    kind: mediaKind,
    type: z.string(), //mediasoup consumer type 'simple' | 'simulcast' | 'svc' | 'pipe';
    rtpParameters: z.any(),
    appData: z.any(),
    producerPaused: z.boolean(),
  }),

  medianodeConnectionData: z.object({
    status: z.enum(['success', 'failed']),
    nodeId: z.string(),
    connectionId: z.string(),
    message: z.string(),
    timestamp: z.number(),
    // serverMetrics: z.any(),
    routerRtpCapabilities: z
      .any()
      .refine(value => value, 'Can not be null or undefined'),
    appData: z.any(),
  }),

  ConsumerStateData: roomIdPeerIdSchema.extend({
    consumerId: z.string(),
    producerPeerId: z.string(),
    producerSource: producerSource,
    fromProducer: z.boolean(),
  }),

  createProducer: z.object({
    transportId: z.string(),
    kind: z.enum(['audio', 'video']),
    rtpParameters: z
      .any()
      .refine(value => value, 'Can not be null or undefined'),
    appData: z.any(),
  }),

  producer: z.object({
    producerId: z.string(),
    source: producerSource,
  }),

  consumer: z.object({
    consumerId: z.string(),
    source: producerSource,
  }),

  mediaNodeAdded: z.object({
    id: z.string(),
    ip: z.string(),
    grpcPort: z.union([z.string(), z.number()]),
  }),
  mediaNodeRemoved: z.object({
    id: z.string(),
  }),

  sendChat: z.object({
    id: z.string(),
    text: z.string(),
    sender: peerDataSchema,
    receiver: peerDataSchema.optional(),
    createdAt: z.number(),
  }),
  sendReaction: z.object({
    id: z.string(),
    name: z.string(),
    sender: peerDataSchema,
    position: z.string(),
    timestamp: z.number(),
  }),

  raiseHand: z.object({
    raised: z.boolean(),
  }),
};

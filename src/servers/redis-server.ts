import { createClient, RedisClientType } from 'redis';
import { PubSubEvents } from '../types/events';
import config from '../config/config';

class RedisServer {
  static client: RedisClientType | null = null;
  static subscriber: RedisClientType | null = null;

  static async init(): Promise<void> {
    try {
      if (this.client) {
        console.warn('Redis client is already initialized.');
        return;
      }

      // Initialize the Redis client
      this.client = createClient({
        url: config.redisServerUrl,
      });

      // Duplicate the client for subscriber
      this.subscriber = this.client.duplicate();

      this.client.on('connect', () => console.info('Redis client connected.'));
      this.client.on('error', err =>
        console.error('Redis Client Error', { error: err })
      );

      this.subscriber.on('connect', () =>
        console.info('Redis subscriber connected.')
      );
      this.subscriber.on('error', err =>
        console.error('Redis Subscriber Error', { error: err })
      );

      await Promise.all([this.client.connect(), this.subscriber.connect()]);

      this.subscribe();

      console.info('Redis server initialized successfully.');
    } catch (error) {
      console.error('Failed to initialize Redis client.', { error });
      throw error; // Rethrow the error to be handled in the application
    }
  }

  // Publish a message to a specific channel
  static async publish({
    event,
    args,
  }: {
    event: PubSubEvents;
    args: { [key: string]: unknown };
  }) {
    if (!this.client) {
      throw new Error('Redis client not initialized.');
    }
    const message = JSON.stringify({ event, args });

    await this.client.publish('message', message);
    console.info(`Message published to channe ${message}`);
  }

  // Subscribe to a specific channel and handle incoming messages
  static async subscribe() {
    if (!this.subscriber) {
      throw new Error('Redis subscriber not initialized.');
    }

    await this.subscriber.subscribe('message', message => {
      console.info(`Message received on channel : ${message}`);
      const {
        event,
        args,
      }: {
        event: PubSubEvents;
        args: { [key: string]: unknown };
      } = JSON.parse(message);

      console.log({ event, args });

      // const handler = PubSubHandler[event];

      // handler && handler(args);
      // handler(message);
    });
  }

  // Unsubscribe from a channel
  static async unsubscribe(channel: string) {
    if (!this.subscriber) {
      throw new Error('Redis subscriber not initialized.');
    }

    await this.subscriber.unsubscribe(channel);
    console.info(`Unsubscribed from channel "${channel}"`);
  }
  /**
   * Safely close the Redis client connection.
   */
  static async disconnect(): Promise<void> {
    if (this.client) {
      try {
        if (this.subscriber) {
          await this.subscriber.quit();
        }
        if (this.client) {
          await this.client.quit();
        }
        console.log('Redis client closed successfully');
      } catch (error) {
        console.error('Error while closing Redis client.', { error });
      } finally {
        this.subscriber = null;
        this.client = null;
      }
    }
  }
}

export default RedisServer;

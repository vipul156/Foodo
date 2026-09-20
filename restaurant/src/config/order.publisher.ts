import { getChannelAsync } from "./rabbitmq.js";

export const publishEvent = async (type: string, data: any) => {
    // Order-flow events must not be silently dropped during a short
    // RabbitMQ blip — wait briefly for a live channel. A persistent
    // outage surfaces as a rejection (5xx) the client can retry, instead
    // of a silent fire-and-forget loss.
    const channel = await getChannelAsync();
    
    channel.sendToQueue(
        process.env.ORDER_QUEUE!,
        Buffer.from(JSON.stringify({ type, data })),
        { persistent: true }
    );
}

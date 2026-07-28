import { getChannel } from "./rabbitmq.js";

export const publishEvent = async (type: string, data: any) => {
    const channel = await getChannel();
    
    channel.sendToQueue(
        process.env.ORDER_QUEUE!,
        Buffer.from(JSON.stringify({ type, data })),
        { persistent: true }
    );
}

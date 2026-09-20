import amqp from 'amqplib'

let channel: amqp.Channel 

export const connectRabbitMQ = async () => {
    try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL!)
        channel = await connection.createChannel()

        // Order-events fanout exchange — rider domain events (order accepted,
        // releases) are published here; restaurant and realtime consume via
        // their own queues. Declaring it here too is idempotent.
        await channel.assertExchange(
            process.env.REALTIME_EXCHANGE || "order.status_changed",
            "fanout",
            { durable: true }
        )

        await channel.assertQueue(process.env.RIDER_QUEUE!, { durable: true })
        
        await channel.assertQueue(process.env.ORDER_QUEUE!, { durable: true })
        
        console.log('Connected to RabbitMQ')
    } catch (error) {
        console.error('Error connecting to RabbitMQ:', error)
    }
}

export const getChannel = () => {
    return channel
}
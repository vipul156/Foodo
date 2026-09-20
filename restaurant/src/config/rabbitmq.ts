import amqp from 'amqplib'

let channel: amqp.Channel 

export const connectRabbitMQ = async () => {
    try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL!)
        channel = await connection.createChannel()

        // Realtime events fanout exchange — this service publishes and
        // forgets; the realtime service owns the queue side. Declaring it
        // here too is idempotent and fails fast if RabbitMQ is down.
        await channel.assertExchange(
            process.env.REALTIME_EXCHANGE || "order.status_changed",
            "fanout",
            { durable: true }
        )

        await channel.assertQueue(process.env.PAYMENT_QUEUE!, { durable: true })
        
        await channel.assertQueue(process.env.ORDER_QUEUE!, { durable: true })
        
        console.log('Connected to RabbitMQ')
    } catch (error) {
        console.error('Error connecting to RabbitMQ:', error)
    }
}

export const getChannel = () => {
    return channel
}
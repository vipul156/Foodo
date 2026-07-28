import axios from "axios";
import { getChannel } from "./rabbitmq.js";
import { Rider } from "../model/Rider.js";

export const startOrderReadyConsumer = async() => {
    const channel = getChannel()

    console.log("Starting to consume from:", process.env.ORDER_QUEUE!)

    channel.consume(process.env.ORDER_QUEUE!, async(msg) =>{
        if(!msg) return;

        try{
            const event = JSON.parse(msg.content.toString())

            if(event.type !== "order:ready_for_rider"){
                channel.ack(msg)
                return;
            }

            const {orderId, restaurantId, location} = event.data
            
            const riders = await Rider.find({
                isAvailable: true,
                isVerified: true,
                location:{
                    $near: {
                        $geometry: location,
                        $maxDistance: 500,
                    }
                }
            })

            if(riders.length === 0){
                // No riders available, send notification to restaurant
                console.log("No riders available for order:", orderId)
                channel.ack(msg)
                return;
            }

            for(const rider of riders){
                try{
                  await axios.post(`${process.env.REALTIME_SERVICE}/api/v1/internal/emit`, {
                    event: "order:available",
                    room: `user:${rider.userId}`,
                    payload: {orderId, restaurantId}
                  },
                  {
                    headers: {
                      "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
                    },
                  },
                );
                    
                } catch(error){
                    console.error("Error assigning order to rider:", error)
                }
            }
            channel.ack(msg)
        } catch(error){
            console.error("Error processing order ready event:", error)
        }
    })
}
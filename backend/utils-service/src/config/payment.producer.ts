import { getChannel } from "./rabbitmq.js";

export const publishPaymentSuccess = async (paymentData: {
  orderId: string;
  paymentId: string;
  provider: "razorpay" | "stripe"
}) => {
  const channel = getChannel();
  channel.sendToQueue(
    process.env.PAYMENT_QUEUE!,
    Buffer.from(
      JSON.stringify({
        type: "PAYMENT_SUCCESS",
        data: paymentData
      })
    ),
    {persistent: true}
  );
};

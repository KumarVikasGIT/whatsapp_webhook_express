const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const token = process.env.TOKEN;
const verifyToken = process.env.MYTOKEN;
const orderPattern = /^SRVZ-ORD-\d{9}$/i;
const actionPattern = /^accept\d+$/;
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Webhook server is listening on port ${PORT}`);
});

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const token = req.query["hub.verify_token"];

  if (mode === "subscribe" && token === verifyToken) {
    console.log("Webhook verified successfully.");
    return res.status(200).send(challenge);
  }
  console.warn("Webhook verification failed.");
  res.sendStatus(403);
});

// Main webhook endpoint
app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("\ud83d\udce9 Received webhook event:", JSON.stringify(body, null, 2));

  const entry = body.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  const metadata = entry?.metadata;
  const contact = entry?.contacts?.[0];
  const messageType = message?.type;

  if (!body.object || !message || !metadata || !contact) {
    console.warn("\u26a0\ufe0f Invalid webhook structure");
    return res.sendStatus(404);
  }

  const phoneNumberId = metadata.phone_number_id;
  const sender = message.from;
  const senderName = contact.profile?.name || "Unknown";

  try {
    if (messageType === "interactive") {
      const listReply = message?.interactive?.list_reply;
      const replyId = listReply?.id;
      const replyTitle = listReply?.title;

      if (actionPattern.test(replyId)) {
        await sendTextMessage(phoneNumberId, sender, `We got your request and updated your order status...\nPlease message \"Hello\" or \"Hi\" to start a new conversation.`);
        return res.sendStatus(200);
      }

      const orderStatusMap = {
        pendingOrders: "technician_assigned",
        wipOrders: "technician_working",
        completedOrders: "technician_work_completed"
      };

      if (orderStatusMap[replyId]) {
        try {
          const response = await axios.get(
            `${process.env.BASE_URL_ORDERS}?orderStatus=${orderStatusMap[replyId]}&technician=${process.env.TECHNICIAN}`,
            {
              headers: {
                "Content-Type": "application/json",
                "Authorization": process.env.AUTH_TOKEN
              }
            }
          );

          const formatted = formatOrders(response.data);
          console.log("\ud83d\udcca Formatted Orders:", JSON.stringify(formatted));
          await sendInteractiveOrderList(phoneNumberId, sender, replyTitle, formatted);
          return res.status(200).send({ success: true });
        } catch (error) {
          console.error("\u274c API Error:", error.response?.data || error.message);
          return res.status(500).send({ success: false });
        }
      }

      if (orderPattern.test(replyTitle)) {
        try {
          const response = await axios.get(
            `${process.env.BASE_URL_ORDERS}/${replyId}`,
            {
              headers: {
                "Content-Type": "application/json",
                "Authorization": process.env.AUTH_TOKEN
              }
            }
          );
      
          const orderData = response.data?.payload;
          if (!orderData) throw new Error("No order data received");

          if(orderData.orderStatus.currentStatus==="technician_assigned"){
            await sendInteractiveOrderDetails(phoneNumberId, sender, orderData, [
                {
                  type: "reply",
                  reply: {
                    id: "acceptOrder",
                    title: "Accept Order"
                  }
                },
                {
                  type: "reply",
                  reply: {
                    id: "rejectOrder",
                    title: "Reject Order"
                  }
                }
              ]);
          }

          if(orderData.orderStatus.currentStatus==="technician_accepted"){
            await sendInteractiveOrderDetails(phoneNumberId, sender, orderData, [
                {
                  type: "reply",
                  reply: {
                    id: "technicianReachedLocation",
                    title: "Update Status"
                  }
                }
              ]);
          }

          if(orderData.orderStatus.currentStatus==="technician_on_location"){
            await sendInteractiveOrderDetails(phoneNumberId, sender, orderData, [
                {
                  type: "reply",
                  reply: {
                    id: "technicianWIP",
                    title: "Update Status"
                  }
                }
              ]);
          }

          if(orderData.orderStatus.currentStatus==="technician_working"){
            await sendInteractiveOrderDetails(phoneNumberId, sender, orderData, [
                {
                  type: "reply",
                  reply: {
                    id: "makePartRequest",
                    title: "Make Part Request"
                  }
                }
              ]);
          }
    
          return res.sendStatus(200);
        } catch (error) {
          console.error("❌ API Error:", error.response?.data || error.message);
          return res.status(500).send({ success: false });
        }
      }
      

      await sendInteractiveOrderList(phoneNumberId, sender, replyTitle);
      return res.sendStatus(200);
    }

    await sendInteractiveOptions(phoneNumberId, sender);
    res.sendStatus(200);
  } catch (error) {
    console.error("\u274c Error sending message:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// Format order data
function formatOrders(data) {
  if (!data?.payload?.items?.length) return [];

  return data.payload.items.map(item => ({
    id: item._id,
    title: item.orderId,
    description: `${item.category?.name || ''} - ${item.subCategory?.name || ''} | ${item.brand?.name || ''} | ${item.warranty || ''} | ${item.serviceComment || ''}`
  }));
}

// Send text message
const sendTextMessage = async (phoneNumberId, to, message) => {
  await axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: message }
    },
    { headers: { "Content-Type": "application/json" } }
  );
};

// Send interactive options (main menu)
const sendInteractiveOptions = async (phoneNumberId, to) => {
  await axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: `Hi ${to}, welcome to SERVIZ Technician BOT.` },
        body: { text: "Please select an option to continue" },
        action: {
          button: "Get Orders by Status",
          sections: [
            {
              title: "Your Options",
              rows: [
                { id: "pendingOrders", title: "Pending Orders", description: "Not started yet." },
                { id: "wipOrders", title: "WIP Orders", description: "In progress." },
                { id: "completedOrders", title: "Completed Orders", description: "Recently completed." }
              ]
            }
          ]
        }
      }
    },
    { headers: { "Content-Type": "application/json" } }
  );
};

// Send interactive list of orders
const sendInteractiveOrderList = async (phoneNumberId, to, title, orders=[]) => {
  await axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: title },
        body: { text: `Here are the orders that are ${title}. Click below to get more details.` },
        action: {
          button: "View Orders",
          sections: [
            {
              title,
              rows: orders
            }
          ]
        }
      }
    },
    { headers: { "Content-Type": "application/json" } }
  );
};

// Send interactive details for each order
const sendInteractiveOrderDetails = async (phoneNumberId, to, orderData, options=[]) => {
    const { orderId, category, subCategory, package: pkg, serviceDateTime, user, address, orderStatus } = orderData;
  
    const formattedDate = new Date(serviceDateTime).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  
    await axios.post(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          header: { type: "text", text: `Order ID: ${orderId}` },
          body: {
            text: `📦 *Order Details*\n\n🆔 *Current Status:* ${orderStatus.state}\n📅 *Schedule:* ${formattedDate}\n\n🔧 *Appliance*\n• Category: ${category?.name}\n• Subcategory: ${subCategory?.name}\n• Issue: ${pkg?.issue}\n\n👤 *Customer*\n• Name: ${user?.firstName}\n• Address: ${address?.address}, ${address?.city}\n• Phone: ${user?.mobile}`
          },
          footer: { text: "Click for more options to Accept, Reject or Change Status" },
          action: {
            buttons: options
          }
        }
      },
      { headers: { "Content-Type": "application/json" } }
    );
  };
  

// Default route
app.get("/", (req, res) => {
  res.status(200).send("Hello, this is the WhatsApp webhook setup!");
});

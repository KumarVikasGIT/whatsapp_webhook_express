const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const {
  TOKEN,
  MYTOKEN: VERIFY_TOKEN,
  BASE_URL_STATUS,
  BASE_URL_ORDERS,
  AUTH_TOKEN,
  TECHNICIAN,
  PORT = 3000
} = process.env;

const orderPattern = /^SRVZ-ORD-\d{9,10}$/i;
const actionPattern = /^accept\d+$/;

app.listen(PORT, () => {
  console.log(`✅ Webhook server running on port ${PORT}`);
});

// Helper - centralized axios instance
const api = axios.create({
  headers: {
    "Content-Type": "application/json",
    "Authorization": AUTH_TOKEN
  }
});

// ID Helpers
const createCustomId = (data = {}) =>
  Object.entries(data).map(([k, v]) => `${k}:${v}`).join("|");

const parseCustomId = (idString = "") =>
    idString.split("|").reduce((acc, part) => {
      const separatorIndex = part.indexOf(":");
      if (separatorIndex > -1) {
        const key = part.slice(0, separatorIndex);
        const value = part.slice(separatorIndex + 1);
        if (key) acc[key] = value;
      }
      return acc;
    }, {});
  

// Webhook verification
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.challenge": challenge, "hub.verify_token": token } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Webhook verification failed");
  res.sendStatus(403);
});

// Main webhook endpoint
app.post("/webhook", async (req, res) => {
  const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  const metadata = entry?.metadata;
  const contact = entry?.contacts?.[0];

  if (!message || !metadata || !contact) {
    console.warn("⚠️ Invalid webhook payload structure");
    return res.sendStatus(404);
  }

  const { phone_number_id: phoneNumberId } = metadata;
  const sender = message.from;
  const senderName = contact.profile?.name || "Unknown";
  const messageType = message.type;

  try {
    if (messageType === "interactive") {
      const listReply = message?.interactive?.list_reply;
      const replyId = parseCustomId(listReply?.id);
      const replyTitle = listReply?.title;

      console.log("id: "+replyId.id);
      console.log("status: "+replyId.status);

      if (actionPattern.test(replyId.status)) {
        await sendTextMessage(phoneNumberId, sender, `✅ Request received!\nMessage "Hello" to start a new conversation.`);
        return res.sendStatus(200);
      }

      const updateStatusMap = {
        acceptOrder: "technician_accepted",
        rejectOrder: "technician_rejected",
        technicianReachedLocation: "technician_on_location",
        technicianWIP: "technician_working",
        makePartRequest: "parts_approval_pending",
        makeMarkComplete: "technician_work_completed"
      };

      const orderStatusMap = {
        pendingOrders: "technician_assigned",
        wipOrders: "technician_working",
        completedOrders: "technician_work_completed"
      };

      if (updateStatusMap[replyId.status]) {
        await updateOrderStatus(replyId, updateStatusMap[replyId.status]);
        return res.sendStatus(200);
      }

      if (orderStatusMap[replyId.status]) {
        const formattedOrders = await fetchOrdersByStatus(orderStatusMap[replyId.status]);
        await sendInteractiveOrderList(phoneNumberId, sender, replyTitle, formattedOrders);
        return res.status(200).send({ success: true });
      }

      if (orderPattern.test(replyTitle)) {
        const orderData = await fetchOrderDetails(replyId.id);
        await handleOrderStatus(phoneNumberId, sender, orderData);
        return res.sendStatus(200);
      }

      await sendTextMessage(phoneNumberId, sender, `We unable to process your request this time please try again.`);
      return res.sendStatus(200);
    }

    await sendInteractiveOptions(phoneNumberId, sender);
    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error handling webhook:", error.message);
    res.sendStatus(500);
  }
});

// ================================
// 🚀 Utility Functions
// ================================

// Update Order Status
const updateOrderStatus = async (replyId, currentStatus) => {
  await api.post(BASE_URL_STATUS, {
    order: {
      orderId: replyId.order,
      _id: replyId.id
    },
    lastStatus: "technician_assigned",
    statusChangeFrom: "admin",
    currentStatus,
    state: formatState(currentStatus)
  });
};

// Format state nicely
const formatState = (status) =>
  status.split("_").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");

// Fetch orders by status
const fetchOrdersByStatus = async (status) => {
  const response = await api.get(`${BASE_URL_ORDERS}?orderStatus=technician_assigned&technician=${TECHNICIAN}`);
  console.log(response.data.payload);
  return formatOrders(response.data);
};

// Fetch specific order details
const fetchOrderDetails = async (id) => {
  const response = await api.get(`${BASE_URL_ORDERS}/${id}`);
  return response.data?.payload;
};

// Handle interactive buttons based on order status
const handleOrderStatus = async (phoneNumberId, sender, orderData) => {
  if (!orderData) throw new Error("No order data found");

  const { currentStatus, orderId, _id } = orderData.orderStatus;

  const optionsMap = {
    technician_assigned: [
      { status: "acceptOrder", title: "Accept Order" },
      { status: "rejectOrder", title: "Reject Order" }
    ],
    technician_accepted: [
      { status: "technicianReachedLocation", title: "Update Status" }
    ],
    technician_on_location: [
      { status: "technicianWIP", title: "Update Status" }
    ],
    technician_working: [
      { status: "makePartRequest", title: "Make Part Request" },
      { status: "makeMarkComplete", title: "Mark Work Complete" }
    ]
  };

  const options = optionsMap[currentStatus]?.map(opt => ({
    type: "reply",
    reply: {
      id: createCustomId({ orderStatus: opt.status, orderId, _id }),
      title: opt.title
    }
  })) || [];

  await sendInteractiveOrderDetails(phoneNumberId, sender, orderData, options);
};

// Format order list
const formatOrders = (data) => 
  data?.payload?.items?.map(item => ({
    id: item._id,
    title: item.orderId,
    description: `${item.category?.name || ''} - ${item.subCategory?.name || ''} | ${item.brand?.name || ''} | ${item.warranty || ''} | ${item.serviceComment || ''}`
  })) || [];

// Send simple text message
const sendTextMessage = (phoneNumberId, to, message) =>
  axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    to,
    text: { body: message }
  });

// Send main menu options
const sendInteractiveOptions = (phoneNumberId, to) =>
  axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
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
        sections: [{
          title: "Your Options",
          rows: [
            { id: "pendingOrders", title: "Pending Orders", description: "Not started yet." },
            { id: "wipOrders", title: "WIP Orders", description: "In progress." },
            { id: "completedOrders", title: "Completed Orders", description: "Recently completed." }
          ]
        }]
      }
    }
  });

// Send orders list
const sendInteractiveOrderList = (phoneNumberId, to, title, orders = []) =>
  axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: title },
      body: { text: `Here are the ${title.toLowerCase()} orders. Tap below.` },
      action: {
        button: "View Orders",
        sections: [{ title, rows: orders }]
      }
    }
  });

// Send detailed order view with buttons
const sendInteractiveOrderDetails = (phoneNumberId, to, orderData, options = []) => {
  const { orderId, category, subCategory, package: pkg, serviceDateTime, user, address, orderStatus } = orderData;
  const formattedDate = new Date(serviceDateTime).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"
  });

  return axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: `Order ID: ${orderId}` },
      body: {
        text: `📦 *Order Details*\n\n🆔 *Status:* ${orderStatus.state}\n📅 *Schedule:* ${formattedDate}\n\n🔧 *Appliance*\n• ${category?.name} - ${subCategory?.name}\n• Issue: ${pkg?.issue}\n\n👤 *Customer*\n• ${user?.firstName}\n• ${address?.address}, ${address?.city}\n• 📞 ${user?.mobile}`
      },
      footer: { text: "Select below to proceed" },
      action: { buttons: options }
    }
  });
};

// Default home route
app.get("/", (req, res) => res.status(200).send("✅ WhatsApp Webhook Setup Working!"));

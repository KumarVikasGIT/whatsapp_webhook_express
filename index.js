// server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { Status, MyOrderStatus } = require("./order_status");
require("dotenv").config();

// Environment Variables
const {
  TOKEN,
  MYTOKEN: VERIFY_TOKEN,
  BASE_URL_STATUS,
  BASE_URL_ORDERS,
  AUTH_TOKEN,
  TECHNICIAN,
  PORT = 3000,
} = process.env;

// Express App Setup
const app = express();
app.use(bodyParser.json());

// Start server
app.listen(PORT, () => console.log(`✅ Webhook server running on port ${PORT}`));

// Axios Instance
const api = axios.create({
  headers: {
    "Content-Type": "application/json",
    Authorization: AUTH_TOKEN,
  },
});

// Utilities: ID Management
const createCustomId = (data = {}) =>
  Object.entries(data)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}:${encodeURIComponent(v)}`)
    .join("|");

const parseCustomId = (idString = "") =>
  idString.split("|").reduce((acc, part) => {
    const [key, value] = part.split(":");
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});

// ========================
// Webhook Verification
// ========================
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Webhook verification failed");
  return res.sendStatus(403);
});

// ========================
// Webhook Handler
// ========================
app.post("/webhook", async (req, res) => {
  const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];
  const metadata = entry?.metadata;
  const contact = entry?.contacts?.[0];

  if (!message || !metadata || !contact) {
    console.warn("⚠️ Invalid webhook payload");
    return res.sendStatus(404);
  }

  const { phone_number_id: phoneNumberId } = metadata;
  const sender = message.from;
  const senderName = contact.profile?.name || "Unknown";

  try {
    if (message.type === "interactive") {
      const reply = message.interactive.list_reply || message.interactive.button_reply;
      const replyId = parseCustomId(reply?.id);
      const replyTitle = reply?.title;

      await handleInteractiveMessage(replyId, replyTitle, phoneNumberId, sender);
      return res.sendStatus(200);
    }

    // Fallback: show default menu
    await sendInteractiveOptions(phoneNumberId, sender);
    return res.sendStatus(200);
    
  } catch (error) {
    console.error("❌ Webhook Processing Error:", error?.response?.data || error.message);
    await sendTextMessage(phoneNumberId, sender, "We are unable to process your request. Please try again later.");
    return res.sendStatus(500);
  }
});

// ========================
// Handlers
// ========================
const handleInteractiveMessage = async (replyId, replyTitle, phoneNumberId, sender) => {
  const updateStatusMap = {
    acceptOrder: "technician_accepted",
    rejectOrder: "technician_rejected",
    technicianReachedLocation: "technician_on_location",
    technicianWIP: "technician_working",
    makePartRequest: "parts_approval_pending",
    makeMarkComplete: "technician_work_completed",
  };

  const orderStatusMap = {
    pendingOrders: "technician_assigned",
    wipOrders: "technician_working",
    completedOrders: "technician_work_completed",
  };

  if (updateStatusMap[replyId.orderStatus]) {
    const status = MyOrderStatus.fromStatusCode(updateStatusMap[replyId.orderStatus]);
    return await updateOrderStatus(replyId, status, replyId.currentStatus, phoneNumberId, sender);
  }

  if (orderStatusMap[replyId.orderStatus]) {
    return await sendOrderSections(orderStatusMap[replyId.orderStatus], replyTitle, phoneNumberId, sender);
  }

  if (/^SRVZ-ORD-\d{9,10}$/i.test(replyTitle)) {
    const orderData = await fetchOrderDetails(replyId.id);
    if (replyId.orderStatus === "technician_work_completed") {
      return await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
    }
    return await handleOrderStatusOptions(phoneNumberId, sender, orderData);
  }

  return await sendTextMessage(phoneNumberId, sender, "Sorry, we couldn't process your selection.");
};

// ========================
// Order Actions
// ========================
const updateOrderStatus = async (replyId, status, lastStatus, phoneNumberId, sender) => {
  try {
    const { data } = await api.post(BASE_URL_STATUS, {
      order: { orderId: replyId.orderId, _id: replyId.id },
      lastStatus,
      currentStatus: status.statusCode,
      state: status.state,
      statusChangeFrom: "admin",
      changeFrom: "admin",
      user: {
        _id: "6464bf7e4f51a5937348796f",
        email: "9934012217@serviz.com",
        firstName: "Rahul",
      },
    });

    if (!data?.payload) throw new Error("Invalid API response");

    console.log("✅ Order status updated:", data.payload._id);
    await sendTextMessage(phoneNumberId, sender, "Order status updated successfully.");
  } catch (error) {
    console.error("❌ updateOrderStatus error:", error?.response?.data || error.message);
    await sendTextMessage(phoneNumberId, sender, "Failed to update order status.");
  }
};

const sendOrderSections = async (status, replyTitle, phoneNumberId, sender) => {
  const sectionConfigs = {
    technician_working: [
      { title: "Work in Progress", statusCode: "technician_working" },
      { title: "Reached Location", statusCode: "technician_on_location" },
      { title: "Part Pending", statusCode: "parts_approval_pending" },
      { title: "Part Handover to Technician", statusCode: "parts_handover_to_tecnician" },
      { title: "Defective Pickup", statusCode: "defective_pickup" },
    ],
    technician_assigned: [
      { title: "Assigned Orders", statusCode: "technician_assigned" },
      { title: "Reassigned Orders", statusCode: "technician_reassigned" },
      { title: "Accepted Orders", statusCode: "technician_accepted" },
    ],
  };

  if (sectionConfigs[status]) {
    const sections = [];

    for (const config of sectionConfigs[status]) {
      const orders = await fetchOrdersByStatus(config.statusCode);
      if (orders.length > 0) {
        sections.push({ title: config.title, rows: orders });
      }
    }

    if (sections.length === 0) {
      await sendTextMessage(phoneNumberId, sender, "Currently you have no pending orders. Try again later.");
      return;
    }

    await sendInteractiveList(phoneNumberId, sender, replyTitle, sections);
  } else {
    const orders = await fetchOrdersByStatus(status);
    if (orders.length === 0) {
      await sendTextMessage(phoneNumberId, sender, "No orders found at this time.");
    } else {
      await sendInteractiveList(phoneNumberId, sender, replyTitle, [{ title: replyTitle, rows: orders }]);
    }
  }
};

const fetchOrdersByStatus = async (status) => {
  try {
    const { data } = await api.get(`${BASE_URL_ORDERS}?orderStatus=${status}&technician=${TECHNICIAN}`);
    return formatOrdersList(data?.payload?.items || []);
  } catch (error) {
    console.error("❌ fetchOrdersByStatus error:", error?.response?.data || error.message);
    return [];
  }
};

const fetchOrderDetails = async (id) => {
  const { data } = await api.get(`${BASE_URL_ORDERS}/${id}`);
  return data?.payload;
};

const handleOrderStatusOptions = async (phoneNumberId, sender, orderData) => {
  const { orderId, _id, orderStatus } = orderData;

  const options = {
    technician_assigned: [
      { status: "acceptOrder", title: "Accept Order" },
      { status: "rejectOrder", title: "Reject Order" },
    ],
    technician_accepted: [
      { status: "technicianReachedLocation", title: "Update Status" },
    ],
    technician_on_location: [
      { status: "technicianWIP", title: "Update Status" },
    ],
    technician_working: [
      { status: "makePartRequest", title: "Request Part" },
      { status: "makeMarkComplete", title: "Mark Work Complete" },
    ],
  }[orderStatus.currentStatus] || [];

  const buttons = options.map(opt => ({
    type: "reply",
    reply: { id: createCustomId({ orderStatus: opt.status, orderId, id: _id, currentStatus: orderStatus.currentStatus }), title: opt.title },
  }));

  return await sendInteractiveButtons(phoneNumberId, sender, orderData, buttons);
};

// ========================
// Message Builders
// ========================
const sendTextMessage = (phoneNumberId, to, message) =>
  axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    to,
    text: { body: message },
  });

const sendInteractiveOptions = (phoneNumberId, to) =>
  axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `Hi ${to}, welcome to SERVIZ Technician Bot.` },
      body: { text: "Please choose an option." },
      action: {
        button: "Get Orders",
        sections: [{
          title: "Options",
          rows: [
            { id: createCustomId({ orderStatus: "pendingOrders" }), title: "Pending Orders", description: "Not yet started." },
            { id: createCustomId({ orderStatus: "wipOrders" }), title: "WIP Orders", description: "In progress." },
            { id: createCustomId({ orderStatus: "completedOrders" }), title: "Completed Orders", description: "Finished." },
          ],
        }],
      },
    },
  });

const sendInteractiveList = (phoneNumberId, to, title, sections) =>
  axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: title },
      body: { text: `Here are your ${title.toLowerCase()} orders.` },
      action: { button: "View Orders", sections },
    },
  });

const sendInteractiveButtons = (phoneNumberId, to, orderData, buttons) => {
  const { orderId, category, subCategory, serviceDateTime, user, address, orderStatus } = orderData;
  const schedule = new Date(serviceDateTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  return axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: `Order ID: ${orderId}` },
      body: {
        text: `📦 Order Details\n\n🆔 Status: ${orderStatus.state}\n📅 Schedule: ${schedule}\n\n🔧 Appliance: ${category?.name} - ${subCategory?.name}\n\n👤 Customer: ${user?.firstName}\n📍 Address: ${address?.address}, ${address?.city}`,
      },
      action: { buttons },
    },
  });
};

const sendOrderDetailsSummary = async (orderData, phoneNumberId, sender) => {
  const schedule = new Date(orderData.serviceDateTime).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  await sendTextMessage(phoneNumberId, sender, 
    `📦 *Order Details*\n\n🆔 *Status:* ${orderData.orderStatus.state}\n📅 *Schedule:* ${schedule}\n\n🔧 *Appliance:* ${orderData.category?.name} - ${orderData.subCategory?.name}\n• Issue: ${orderData.pkg?.issue}\n\n👤 *Customer:* ${orderData.user?.firstName}\n• ${orderData.address?.address}, ${orderData.address?.city}\n• 📞 ${orderData.user?.mobile}`);
};

// Format Orders List
const formatOrdersList = (orders = []) => 
  orders.map(order => ({
    id: createCustomId({ orderStatus: order.orderStatus?.currentStatus, orderId: order.orderId, id: order._id }),
    title: order.orderId,
    description: `${order.category?.name || ""} - ${order.subCategory?.name || ""} | ${order.brand?.name || ""} | ${order.warranty || ""} | ${order.serviceComment || ""}`,
  }));
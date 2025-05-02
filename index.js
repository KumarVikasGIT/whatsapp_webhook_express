// server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { Status, MyOrderStatus } = require("./order_status");
const { DocType, RequiredDocumentData } = require("./doc_type");
const path = require('path');
const fs = require('fs');
require("dotenv").config();

const userStore = {}; // Replace with Redis or DB in production

// Environment Variables
const {
  TOKEN,
  MYTOKEN: VERIFY_TOKEN,
  BASE_URL_STATUS,
  BASE_URL_ORDERS,
  BASE_URL_SC,
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
const api = axios.create();

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

app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Validate WhatsApp object
  if (body.object !== 'whatsapp_business_account') {
    return res.sendStatus(404);
  }

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;

  // ========================
  // 1. Handle Message Statuses
  // ========================
  const statuses = value?.statuses;
  if (statuses && statuses.length > 0) {
    const statusInfo = statuses[0];
    const messageId = statusInfo.id;
    const status = statusInfo.status;
    const recipient = statusInfo.recipient_id;
    const timestamp = statusInfo.timestamp;

    console.log(`📩 Message ${messageId} to ${recipient} is ${status} at ${timestamp}`);
    return res.sendStatus(200); // Exit early after handling status
  }

  // ========================
  // 2. Handle Incoming Messages
  // ========================
  const message = value?.messages?.[0];
  const metadata = value?.metadata;
  const contact = value?.contacts?.[0];

  if (!message || !metadata || !contact) {
    console.warn("⚠️ Invalid webhook payload");
    return res.sendStatus(404);
  }

  const phoneNumberId = metadata.phone_number_id;
  const sender = message.from;
  const senderName = contact.profile?.name || "Unknown";

  const requiredDocuments = {
    invoice: RequiredDocumentData.invoice,
    device: RequiredDocumentData.devicePhoto,
    serial: RequiredDocumentData.serialNo,
  };

  try {

     // ========================
  // 0. OTP Verification Step
  // ========================
  const messageText = message?.text?.body?.trim();
  const userState = await getUserState(sender); // get from DB/cache
  
  if (!userState || userState === 'initial') {
    await setUserState(sender, 'awaiting_phone');
    await sendTextMessage(phoneNumberId, sender, "📱 Please enter your registered mobile number.");
    return res.sendStatus(200);
  }
  
  if (userState === 'awaiting_phone') {
    if (!/^\d{10}$/.test(messageText)) {
      await sendTextMessage(phoneNumberId, sender, "❌ Invalid number. Please enter a valid 10-digit mobile number.");
      return res.sendStatus(200);
    }
  
    await setUserPhone(sender, messageText);
  
    try {
      await generateAndSendOTP(sender, phoneNumberId, messageText);
      await setUserState(sender, 'awaiting_otp');
      await sendTextMessage(phoneNumberId, sender, "✅ OTP has been sent successfully. Please enter the OTP.");
    } catch (err) {
      // Already handled inside generateAndSendOTP
    }
  
    return res.sendStatus(200);
  }
  
  
  if (userState === 'awaiting_otp') {
    if (messageText.toLowerCase() === 'resend') {
      const phone = userStore[sender]?.phone;
      if (!phone) {
        await sendTextMessage(phoneNumberId, sender, "⚠️ Phone number not found. Please re-enter your number.");
        await setUserState(sender, 'awaiting_phone');
        return res.sendStatus(200);
      }
  
      await generateAndSendOTP(sender, phoneNumberId, phone);
      await sendTextMessage(phoneNumberId, sender, "🔄 OTP has been resent. Please enter the new OTP.");
      return res.sendStatus(200);
    }
  
    const isValidOtp = await verifyOTP(messageText, userStore[sender]?.phone, sender);
    if (!isValidOtp) {
      const retries = (userStore[sender].otpRetries || 0) + 1;
      userStore[sender].otpRetries = retries;
  
      if (retries >= 3) {
        await sendTextMessage(phoneNumberId, sender, "❌ Too many incorrect attempts. Please type 'resend' to get a new OTP.");
      } else {
        await sendTextMessage(phoneNumberId, sender, `❌ Invalid OTP. Attempt ${retries}/3. Try again or type 'resend' to get a new OTP.`);
      }
      return res.sendStatus(200);
    }
  
    await setUserState(sender, 'verified');
    userStore[sender].otpRetries = 0; // Reset retry counter
    await sendTextMessage(phoneNumberId, sender, "✅ OTP verified successfully. How can I help you today?");
     // Default fallback: send menu
     await sendInteractiveOptions(phoneNumberId, sender);
    return res.sendStatus(200);
  }  
  
    if (message.type === "interactive") {
      const reply = message.interactive.list_reply || message.interactive.button_reply;
      const replyId = parseCustomId(reply?.id);
      const replyTitle = reply?.title;

      await handleInteractiveMessage(replyId, replyTitle, phoneNumberId, sender);
      return res.sendStatus(200);
    }

    if (message.type === "image") {
      const caption = message.image.caption?.trim().toLowerCase();

      if (!caption || !requiredDocuments[caption]) {
        await sendTextMessage(
          phoneNumberId,
          sender,
          "Document name not found or invalid. Please reupload the image with a valid document name (e.g., invoice, serial, device)."
        );
        return res.sendStatus(200);
      }

      await downloadAndSaveImage(message.image.id); // ensure this is async if needed
      return res.sendStatus(200);
    }

    // Default fallback: send menu
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
    uploadDocument: "uploadDocument",
    verifyDocument:"verifyDocument"
  };

  if (updateStatusMap[replyId.orderStatus]) {
    const status = MyOrderStatus.fromStatusCode(updateStatusMap[replyId.orderStatus]);
    return await updateOrderStatus(replyId, status, replyId.currentStatus, phoneNumberId, sender);
  }

  if (orderStatusMap[replyId.orderStatus]) {
    if(orderStatusMap[replyId.orderStatus]==="uploadDocument"){
        return await sendInteractiveDocumentButtons(phoneNumberId,sender,"Upload Document","Please upload these required documents to Continue:\n\n1. Device Photo\n2. Serial Number\n3. Invoice Photo\n\nPlease upload images with the name mensioned above.",
            [
                {
                    type: "reply",
                    reply: { 
                        id: createCustomId({ orderStatus: "verifyDocument"}), 
                        title: "Verify DOduments"
                }
                }
            ]
        );
    }

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
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: userStore[sender].token,
        },
      });
  
      if (!data?.payload) throw new Error("Invalid API response");
  
      console.log("✅ Order status updated:", data.payload._id);
  
      // Inform user order updated
      await sendTextMessage(phoneNumberId, sender, "Order status updated successfully.");
  
      // Handle specific cases
      if (status.state === "technician_rejected") {
        await sendTextMessage(phoneNumberId, sender, "You no longer have access to this order.");
        return; // Stop further processing
      }
  
      if (status.state === "technician_work_completed") {
        await sendTextMessage(phoneNumberId, sender, "You have successfully completed your order. Say 'Hi' to start a new order.");
        return; // Stop further processing
      }
  
      // Otherwise, continue to fetch updated order details and show options
      const orderData = await fetchOrderDetails(data.payload.order._id);
      return await handleOrderStatusOptions(phoneNumberId, sender, orderData);
  
    } catch (error) {
      console.error("❌ updateOrderStatus error:", error?.response?.data || error.message);
     return await sendTextMessage(phoneNumberId, sender, "Failed to update order status. Please try again later.");
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

    return await sendInteractiveList(phoneNumberId, sender, replyTitle, sections);
  } else {
    const orders = await fetchOrdersByStatus(status);
    if (orders.length === 0) {
     return await sendTextMessage(phoneNumberId, sender, "No orders found at this time.");
    } else {
     return await sendInteractiveList(phoneNumberId, sender, replyTitle, [{ title: replyTitle, rows: orders }]);
    }
  }
};

const fetchOrdersByStatus = async (status) => {
  try {
    const { data } = await api.get(`${BASE_URL_ORDERS}?orderStatus=${status}&technician=${userStore[sender].userId}`,  {
      headers: {
        "Content-Type": "application/json",
        Authorization: userStore[sender].token,
      },
    });
    return formatOrdersList(data?.payload?.items || []);
  } catch (error) {
    console.error("❌ fetchOrdersByStatus error:", error?.response?.data || error.message);
    return [];
  }
};

const fetchOrderDetails = async (id) => {
  const { data } = await api.get(`${BASE_URL_ORDERS}/${id}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: userStore[sender].token,
    },
  });
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
        { status: "uploadDocument", title: "Upload Document" },
      ],
    // technician_working: [
    //   { status: "makePartRequest", title: "Request Part" },
    //   { status: "makeMarkComplete", title: "Mark Work Complete" },
    // ],
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

const sendInteractiveDocumentButtons = (phoneNumberId, to ,title, body, buttons) => {  
    return axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: title },
        body: {
          text: body,
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

  // download and save image
  async function downloadAndSaveImage(mediaId) {
    try {
      // 1. Get media URL
      const mediaInfo = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        }
      });
  
      const imageUrl = mediaInfo.data.url;
      console.log('Image URL:', imageUrl);
  
      // 2. Download the image
      const response = await axios.get(imageUrl, {
        headers: {
          Authorization: `Bearer ${TOKEN}`
        },
        responseType: 'stream' // important: so we can pipe the data to file
      });
  
      // 3. Save to local disk
      const filePath = path.join(`${__dirname}/uploads`, `${mediaId}.jpg`); // or any folder you want
      const writer = fs.createWriteStream(filePath);
  
      response.data.pipe(writer);
  
      writer.on('finish', () => {
        console.log('✅ Image successfully saved to', filePath);
      });
  
      writer.on('error', (err) => {
        console.error('❌ Error saving image:', err);
      });
  
    } catch (error) {
      console.error('❌ Error downloading image:', error.response?.data || error.message);
    }
  }

  async function getUserState(sender) {
    return userStore[sender]?.state || 'initial';
  }
  
  async function setUserState(sender, state) {
    if (!userStore[sender]) userStore[sender] = {};
    userStore[sender].state = state;
  }
  
  async function setUserPhone(sender, phone) {
    userStore[sender].phone = phone;
  }
  
  async function generateAndSendOTP(sender, phoneNumberId, phone) {
    try {  
      const { data } = await api.post(`${BASE_URL_SC}employee-login-otp/sent`, {
        mobile: phone,
      });
      return data;
    } catch (error) {
      console.error('Error sending OTP:', error.message || error);
      await sendTextMessage(phoneNumberId, sender, `❌ Failed to send OTP: Please try again later`);
      throw error; // rethrow to allow the caller to know it failed
    }
  }
  
  
  async function verifyOTP(otp, phone, sender) {
    try {  
      const { data } = await api.post(`${BASE_URL_SC}employee-login-otp/confirm`, {
        mobile: phone,
        otp:otp
      },
    );
      userStore[sender].token=data.payload.token;
      userStore[sender].userId=data.payload.userId;
      console.error('OTP:', JSON.stringify(data));
      return data.status;
    } catch (error) {
      console.error('Error verify OTP:', error.message || error);
      console.error('OTP:', JSON.stringify(error));
      // await sendTextMessage(phoneNumberId, sender, `❌ Failed to Verify: ${error.message || 'Please try again later.'}`);
      return false;
    }
  }
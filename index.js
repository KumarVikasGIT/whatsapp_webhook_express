const express = require("express");
const cors = require("cors");
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
app.use(cors()); // Allow all origins (for testing, this is okay)

app.use(express.json());
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

  console.log("🔍 Incoming webhook verification request:");
  console.log("➡️ Mode:", mode);
  console.log("➡️ Token:", token);
  console.log("➡️ Challenge:", challenge);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Webhook verification failed.");
  console.warn("Expected token:", VERIFY_TOKEN);
  console.warn("Received token:", token);
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
    defectivePartPickup: "defective_pickup",
    anotherPartRequest: "another_parts_approval_pending",
    makeMarkComplete: "technician_work_completed",
  };

  const orderStatusMap = {
    pendingOrders: "technician_assigned",
    wipOrders: "technician_working",
    completedOrders: "technician_work_completed",
    uploadDocument: "uploadDocument",
    verifyDocument: "verifyDocument"
  };

  const sendPartRequestForm = async (isAnotherPart, orderData) => {
    const partTypeText = isAnotherPart ? "another part" : "a part";
    const formURL = `https://kumarvikasgit.github.io/technician-bot-forms/part-request?token=${userStore[sender].token}&id=${replyId.id}&orderId=${replyId.orderId}&sender=${sender}&phoneNoId=${phoneNumberId}&category=${orderData.category._id}&brand=${orderData.brand._id}&modelNo=${orderData.modelNo}&currentStatus=technician_working&userId=${userStore[sender].userId}&userName=${userStore[sender].userName}&anotherPart=${isAnotherPart}`;

    const message = `Make ${partTypeText} request\n\n1. Select Required from the Part List.\n2. Select the Part Provider.\n3. Select the Quantity.\n4. Add Serial number of the part.\n5. Upload photo of the part.\n\nAfter filling the details, add part(s) to the list and click "Send Part Request" to update the order.`;

    return await sendInteractiveCtaUrlMessage(phoneNumberId, sender, message, "Make Part Request", formURL);
  };

  const handleUpdateStatus = async () => {
    const statusCode = updateStatusMap[replyId.orderStatus];
    const orderData = await fetchOrderDetails(replyId.id, sender);

    switch (statusCode) {
      case "defective_pickup":
        return await sendInteractiveCtaUrlMessage(
          phoneNumberId,
          sender,
          "Please upload these required documents to continue:\n\n1. Defective Part Photo",
          "Upload Defective",
          `https://kumarvikasgit.github.io/technician-bot-forms/defective-pickup?token=${userStore[sender].token}&id=${replyId.id}&orderId=${replyId.orderId}&sender=${sender}&phoneNumberId=${phoneNumberId}`
        );

      case "parts_approval_pending":
        return await sendPartRequestForm(false, orderData);

      case "another_parts_approval_pending":
        return await sendPartRequestForm(true, orderData);

      default:
        const status = MyOrderStatus.fromStatusCode(statusCode);
        return await updateOrderStatus(replyId, status, replyId.currentStatus, phoneNumberId, sender);
    }
  };

  const handleOrderStatusMap = async () => {
    const mappedStatus = orderStatusMap[replyId.orderStatus];

    if (mappedStatus === "uploadDocument") {
      const docUrl = `https://kumarvikasgit.github.io/technician-bot-forms/upload-document?token=${userStore[sender].token}&id=${replyId.id}&orderId=${replyId.orderId}&sender=${sender}&phoneNumberId=${phoneNumberId}`;
      const docMsg = "Please upload these required documents to continue:\n\n1. Device Photo\n2. Serial Number\n3. Invoice Photo\n\nPlease upload images with the names mentioned above.";
      return await sendInteractiveCtaUrlMessage(phoneNumberId, sender, docMsg, "Upload Document", docUrl);
    }

    return await sendOrderSections(mappedStatus, replyTitle, phoneNumberId, sender);
  };

  try {
    if (updateStatusMap[replyId.orderStatus]) {
      return await handleUpdateStatus();
    }

    if (orderStatusMap[replyId.orderStatus]) {
      return await handleOrderStatusMap();
    }

    if (/^SRVZ-ORD-\d{9,10}$/i.test(replyTitle)) {
      const orderData = await fetchOrderDetails(replyId.id, sender);
      if (replyId.orderStatus === "technician_work_completed") {
        return await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
      }
      return await handleOrderStatusOptions(phoneNumberId, sender, orderData);
    }

    return await sendTextMessage(phoneNumberId, sender, "Sorry, we couldn't process your selection.");
  } catch (error) {
    console.error("Error handling interactive message:", error);
    return await sendTextMessage(phoneNumberId, sender, "Something went wrong while processing your request.");
  }
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
      const orderData = await fetchOrderDetails(data.payload.order._id, sender);
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
      { title: "Part Handoverd", statusCode: "parts_handover_to_tecnician" },
      { title: "Defective Pickup", statusCode: "defective_pickup" },
    ],
    technician_assigned: [
      { title: "Assigned Orders", statusCode: "technician_assigned" },
      { title: "Reassigned Orders", statusCode: "technician_reassigned" },
      { title: "Accepted Orders", statusCode: "technician_accepted" },
    ],
    technician_work_completed: [
      { title: "Completed Orders", statusCode: "technician_work_completed" },
    ],
  };

  if (sectionConfigs[status]) {
    const sections = [];

    for (const config of sectionConfigs[status]) {
      const orders = await fetchOrdersByStatus(config.statusCode, sender);
      if (orders.length > 0) {
        sections.push({ title: config.title, rows: orders });
      }
    }

    if (sections.length === 0) {
      await sendTextMessage(phoneNumberId, sender, "Currently you have no pending orders. Please check after some time.");
      return;
    }

    return await sendInteractiveList(phoneNumberId, sender, replyTitle, sections);
  } else {
    const orders = await fetchOrdersByStatus(status, sender);
    if (orders.length === 0) {
     return await sendTextMessage(phoneNumberId, sender, "No orders found at this time.");
    } else {
     return await sendInteractiveList(phoneNumberId, sender, replyTitle, [{ title: replyTitle, rows: orders }]);
    }
  }
};

const fetchOrdersByStatus = async (status, sender) => {
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

const fetchOrderDetails = async (id, sender) => {
  const { data } = await api.get(`${BASE_URL_ORDERS}/${id}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: userStore[sender].token,
    },
  });
  return data?.payload;
};

const handleOrderStatusOptions = async (phoneNumberId, sender, orderData) => {
  if (!orderData || !orderData.orderStatus || !orderData.orderStatus.currentStatus) {
    console.warn("⚠️ Missing or invalid order status data:", orderData);
    return await sendTextMessage(phoneNumberId, sender, "⚠️ Unable to display options due to missing order status.");
  }

  const { orderId, _id, orderStatus } = orderData;
  const currentStatus = orderStatus.currentStatus;

  const statusOptionsMap = {
    technician_assigned: [
      { status: "acceptOrder", title: "Accept Order" },
      { status: "rejectOrder", title: "Reject Order" },
    ],
    technician_reassigned: [
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
      { status: "makePartRequest", title: "Make Part Request" },
      { status: "makeMarkComplete", title: "Mark Work Complete" },
    ],
    parts_approval_pending: [
      { status: "anotherPartRequest", title: "Another Part Request" },
      { status: "defectivePartPickup", title: "Defective Pickup" },
    ],
    parts_handover_to_tecnician: [
      { status: "defectivePartPickup", title: "Pickup Defective" },
    ],
    defective_pickup: [
      { status: "uploadDocument", title: "Upload Document" },
      { status: "makePartRequest", title: "Make Part Request" },
      { status: "makeMarkComplete", title: "Mark Work Complete" },
    ],
  };

  const options = statusOptionsMap[currentStatus] || [];

  if (options.length === 0) {
    console.log(`ℹ️ No interactive options for status: ${currentStatus}`);
    return await sendTextMessage(phoneNumberId, sender, `Order Id: ${orderData.orderId}\nℹ️ Current Status: ${orderStatus.state}. No actions available at this time.`);
  }

  const buttons = options.map(opt => ({
    type: "reply",
    reply: {
      id: createCustomId({
        orderStatus: opt.status,
        orderId,
        id: _id,
        currentStatus,
      }),
      title: opt.title,
    },
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

const sendInteractiveCtaUrlMessage = (phoneNumberId, to, bodyText, buttonText, buttonUrl) => {
  return axios.post(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      // header: {
      //   type: "text",
      //   text: headerText
      // },
      body: {
        text: bodyText
      },
      // footer: {
      //   text: footerText
      // },
      action: {
        name: "cta_url",
        parameters: {
          display_text: buttonText,
          url: buttonUrl
        }
      }
    }
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

  app.post("/notify-document-upload", cors(),async (req, res) => {
    try {
      const { id, orderID, sender, status, phoneNumberId } = req.body;
  
      console.log("📥 Received document upload request:", JSON.stringify(req.body, null, 2));
  
      // Validate presence of required fields
      const missingFields = [];
      if (!id) missingFields.push("id");
      if (!orderID) missingFields.push("orderID");
      if (!sender) missingFields.push("sender");
      if (!phoneNumberId) missingFields.push("phoneNumberId");
  
      if (missingFields.length > 0) {
        const errorMsg = `⚠️ Missing required fields: ${missingFields.join(", ")}`;
        console.warn(errorMsg);
        return res.status(400).json({ status: false, message: errorMsg });
      }
  
      // Proceed only if status is true
      if (status === true) {
        try {
          // 1. Acknowledge successful upload
          await sendTextMessage(phoneNumberId, sender, `✅ Document uploaded successfully for Order ${orderID}.`);
  
          // 2. Fetch order details
          const orderData = await fetchOrderDetails(id, sender);
  
          if (!orderData) {
            const msg = "⚠️ Document uploaded, but order data could not be found.";
            console.warn(msg);
            await sendTextMessage(phoneNumberId, sender, msg);
            return res.status(200).json({ status: true, message: msg });
          }
  
          // 3. If work completed, send order summary
          if (orderData.orderStatus?.currentStatus === "technician_work_completed") {
            await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
            return res.status(200).json({ status: true, message: "Summary sent after work completion." });
          }
  
          // 4. Otherwise, show next order status options
          await handleOrderStatusOptions(phoneNumberId, sender, orderData);
          return res.status(200).json({ status: true, message: "Options sent based on order status." });
  
        } catch (fetchError) {
          console.error("❌ Error during order handling:", fetchError.message);
          await sendTextMessage(phoneNumberId, sender, "⚠️ Upload successful, but failed to process order.");
          return res.status(500).json({ status: false, message: "Failed to process order after upload." });
        }
      }
  
      return res.status(200).json({ status: true, message: "Upload acknowledged without status = true." });
    } catch (error) {
      console.error("🔥 Unexpected error in /document-upload:", error);
      return res.status(500).json({ status: false, message: "Internal Server Error" });
    }
  });  

  app.post("/notify-part-update", cors(), async (req, res) => {
    try {
      const { id, orderID, sender, status, phoneNumberId } = req.body;
  
      console.log("📥 Received part update request:", JSON.stringify(req.body, null, 2));
  
      // Validate presence of required fields
      const missingFields = [];
      if (!id) missingFields.push("id");
      if (!orderID) missingFields.push("orderID");
      if (!sender) missingFields.push("sender");
      if (!phoneNumberId) missingFields.push("phoneNumberId");
  
      if (missingFields.length > 0) {
        const errorMsg = `⚠️ Missing required fields: ${missingFields.join(", ")}`;
        console.warn(errorMsg);
        return res.status(400).json({ status: false, message: errorMsg });
      }
  
      // Proceed only if status is true
      if (status === true) {
        try {
          // 1. Acknowledge successful upload
          await sendTextMessage(phoneNumberId, sender, `✅ We receive part update request for Order ${orderID}.`);
  
          // 2. Fetch order details
          const orderData = await fetchOrderDetails(id, sender);
  
          if (!orderData) {
            const msg = "⚠️ Part Updated, but order data could not be found.";
            console.warn(msg);
            await sendTextMessage(phoneNumberId, sender, msg);
            return res.status(200).json({ status: true, message: msg });
          }
  
          // 3. If work completed, send order summary
          if (orderData.orderStatus?.currentStatus === "technician_work_completed") {
            await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
            return res.status(200).json({ status: true, message: "Summary sent after work completion." });
          }
  
          // 4. Otherwise, show next order status options
          await handleOrderStatusOptions(phoneNumberId, sender, orderData);
          return res.status(200).json({ status: true, message: "Options sent based on order status." });
  
        } catch (fetchError) {
          console.error("❌ Error during order handling:", fetchError.message);
          await sendTextMessage(phoneNumberId, sender, "⚠️ Upload successful, but failed to process order.");
          return res.status(500).json({ status: false, message: "Failed to process order after upload." });
        }
      }
  
      return res.status(200).json({ status: true, message: "Upload acknowledged without status = true." });
    } catch (error) {
      console.error("🔥 Unexpected error in /document-upload:", error);
      return res.status(500).json({ status: false, message: "Internal Server Error" });
    }
  });  

  app.post("/notify-defective-part-update", cors(), async (req, res) => {
    try {
      const { id, orderID, sender, status, phoneNumberId } = req.body;
  
      console.log("📥 Received defective part update request:", JSON.stringify(req.body, null, 2));
  
      // Validate presence of required fields
      const missingFields = [];
      if (!id) missingFields.push("id");
      if (!orderID) missingFields.push("orderID");
      if (!sender) missingFields.push("sender");
      if (!phoneNumberId) missingFields.push("phoneNumberId");
  
      if (missingFields.length > 0) {
        const errorMsg = `⚠️ Missing required fields: ${missingFields.join(", ")}`;
        console.warn(errorMsg);
        return res.status(400).json({ status: false, message: errorMsg });
      }
  
      // Proceed only if status is true
      if (status === true) {
        try {
          // 1. Acknowledge successful upload
          await sendTextMessage(phoneNumberId, sender, `✅ We receive defective part update request for Order ${orderID}.`);
  
          // 2. Fetch order details
          const orderData = await fetchOrderDetails(id, sender);
  
          if (!orderData) {
            const msg = "⚠️ Part Updated, but order data could not be found.";
            console.warn(msg);
            await sendTextMessage(phoneNumberId, sender, msg);
            return res.status(200).json({ status: true, message: msg });
          }
  
          // 3. If work completed, send order summary
          if (orderData.orderStatus?.currentStatus === "technician_work_completed") {
            await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
            return res.status(200).json({ status: true, message: "Summary sent after work completion." });
          }
  
          // 4. Otherwise, show next order status options
          await handleOrderStatusOptions(phoneNumberId, sender, orderData);
          return res.status(200).json({ status: true, message: "Options sent based on order status." });
  
        } catch (fetchError) {
          console.error("❌ Error during order handling:", fetchError.message);
          await sendTextMessage(phoneNumberId, sender, "⚠️ Upload successful, but failed to process order.");
          return res.status(500).json({ status: false, message: "Failed to process order after upload." });
        }
      }
  
      return res.status(200).json({ status: true, message: "Upload acknowledged without status = true." });
    } catch (error) {
      console.error("🔥 Unexpected error in /document-upload:", error);
      return res.status(500).json({ status: false, message: "Internal Server Error" });
    }
  });  
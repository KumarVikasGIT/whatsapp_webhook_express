const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const axios = require("axios");
const { Status, MyOrderStatus } = require("./order_status");
const { DocType, RequiredDocumentData } = require("./doc_type");
const { DOCUMENT_TYPES } = require("./doc_types");
const { JWT_TOKEN } = require("./generate-token");
const path = require("path");
const fs = require("fs");
const jwt = require('jsonwebtoken');
require("dotenv").config();

const userStore = {}; // Replace with Redis or DB in production

// Environment Variables
const {
  TOKEN,
  MYTOKEN: VERIFY_TOKEN,
  BASE_URL_STATUS,
  BASE_URL_ORDERS,
  BASE_URL_SC,
  BASE_URL_WHATSAPP_LOGS,
  BASE_URL_REFRESH_TECHNICIAN,
  PORT = 3000,
} = process.env;

// Express App Setup
const app = express();
app.use(cors()); // Allow all origins (for testing, this is okay)

app.use(express.json());
app.use(bodyParser.json());

// Start server
app.listen(PORT, () =>
  console.log(`✅ Webhook server running on port ${PORT}`)
);

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
  const {
    "hub.mode": mode,
    "hub.verify_token": token,
    "hub.challenge": challenge,
  } = req.query;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

const processedMessages = new Set();

app.post("/webhook", async (req, res) => {
  const body = req.body;

  // Validate WhatsApp object
  if (body.object !== "whatsapp_business_account") {
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
  const messageId = message.id;

  // ========================
  // ✋ Ignore Duplicate Messages
  // ========================
  if (processedMessages.has(messageId)) {
    console.log(`⚠️ Duplicate message ${messageId} from ${sender} ignored.`);
    return res.sendStatus(200);
  }
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000); // expire after 5 min

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
    const userState = await getUserState(sender);
    const userData = await getFirstItem(sender);

    if ((!userState || userState === 'initial')&&!userData) {
      await setUserState(sender, "awaiting_phone");
      await sendTextMessage(
        phoneNumberId,
        sender,
        "📱 Please enter your registered mobile number."
      );
      return res.sendStatus(200);
    }

    if (userState === "awaiting_phone") {
      if (!/^\d{10}$/.test(messageText)) {
        await sendTextMessage(
          phoneNumberId,
          sender,
          "❌ Invalid number. Please enter a valid 10-digit mobile number."
        );
        return res.sendStatus(200);
      }

      await setUserPhone(sender, messageText);

      try {
        await generateAndSendOTP(sender, phoneNumberId, messageText);
        await setUserState(sender, "awaiting_otp");
        await sendTextMessage(
          phoneNumberId,
          sender,
          "✅ OTP has been sent successfully. Please enter the OTP."
        );
      } catch (err) {
        // Already handled inside generateAndSendOTP
      }

      return res.sendStatus(200);
    }

    if (userState === "awaiting_otp") {
      if (messageText.toLowerCase() === "resend") {
        const phone = userStore[sender]?.phone;
        if (!phone) {
          await sendTextMessage(
            phoneNumberId,
            sender,
            "⚠️ Phone number not found. Please re-enter your number."
          );
          await setUserState(sender, "awaiting_phone");
          return res.sendStatus(200);
        }

        await generateAndSendOTP(sender, phoneNumberId, phone);
        await sendTextMessage(
          phoneNumberId,
          sender,
          "🔄 OTP has been resent. Please enter the new OTP."
        );
        return res.sendStatus(200);
      }

      const isValidOtp = await verifyOTP(
        messageText,
        userStore[sender]?.phone,
        sender
      );
      if (!isValidOtp) {
        const retries = (userStore[sender].otpRetries || 0) + 1;
        userStore[sender].otpRetries = retries;

        if (retries >= 3) {
          await sendTextMessage(
            phoneNumberId,
            sender,
            "❌ Too many incorrect attempts. Please type 'resend' to get a new OTP."
          );
        } else {
          await sendTextMessage(
            phoneNumberId,
            sender,
            `❌ Invalid OTP. Attempt ${retries}/3. Try again or type 'resend' to get a new OTP.`
          );
        }
        return res.sendStatus(200);
      }

      await setUserState(sender, "verified");
      userStore[sender].otpRetries = 0;
      await sendTextMessage(
        phoneNumberId,
        sender,
        "✅ OTP verified successfully. How can I help you today?"
      );
      await sendInteractiveOptions(phoneNumberId, sender);
      return res.sendStatus(200);
    }

    // ========================
    // Interactive Message Handler
    // ========================
    if (message.type === "interactive") {
      const reply =
        message.interactive.list_reply || message.interactive.button_reply;
      const replyId = parseCustomId(reply?.id);
      const replyTitle = reply?.title;

      await handleInteractiveMessage(
        replyId,
        replyTitle,
        phoneNumberId,
        sender,
        userData
      );
      return res.sendStatus(200);
    }

     if (/^SRVZ-ORD-\d{9,10}$/i.test(messageText)) {
      console.log("valid OrderId", messageText)
      const orderData = await fetchOrdersByOrderId(messageText, userData);

      if(orderData.length<1){
        await sendTextMessage(phoneNumberId, sender, "No order Found Please enter valid Order Id");
        return res.sendStatus(200);
      }

      await sendInteractiveList(phoneNumberId, sender, "Order Search", [
        { title: `${messageText}`, rows: orderData },
      ]);
      return res.sendStatus(200);
    }


    // ========================
    // Default Fallback
    // ========================
    await sendInteractiveOptions(phoneNumberId, sender, userData);
    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "❌ Webhook Processing Error:",
      error?.response?.data || error.message
    );
    await sendTextMessage(
      phoneNumberId,
      sender,
      "We are unable to process your request. Please try again later."
    );
    return res.sendStatus(500);
  }
});

async function getFirstItem(sender) {
  if (!sender || typeof sender !== "string") {
    console.error("[Validation] Invalid sender parameter:", sender);
    return null;
  }

  try {
    var jwt_token = jwt.sign({
      app: 'WhatsApp-Bot',
    }, process.env.JWT_SECRET, {
      expiresIn: '5m',
    });
    // Fetch user data
    const userResponse = await api.get(
      `${BASE_URL_WHATSAPP_LOGS}?userPhoneId=${sender}`,
      {headers: { Authorization: `Bearer ${jwt_token}`, subdomain : "WhatsApp" }}
    );
    const responseData = userResponse?.data;

    if (
      !responseData?.status ||
      !Array.isArray(responseData.payload?.items) ||
      responseData.payload.items.length === 0
    ) {
      console.warn("[API] Invalid response structure or empty user list");
      return null;
    }

    const user = responseData.payload.items[0];
    const { _id, loginPhone, token, rToken } = user;

    if (!token || !rToken) {
      console.error(
        "[Token] Missing access or refresh token for user:",
        loginPhone
      );
      return null;
    }
    // Refresh token
    const refreshResult = await refreshTechnician(token, rToken);
    const newToken = refreshResult?.payload?.token;

    if (!newToken) {
      console.error("[Refresh] Failed to refresh token");
      return null;
    }

    // Update user token
    const updateResponse = await api.put(`${BASE_URL_WHATSAPP_LOGS}/${_id}`, {
      token: newToken,
    },
      {headers: { Authorization: `Bearer ${jwt_token}`,subdomain : "WhatsApp" }});
    const updatedUser = updateResponse?.data?.payload;

    if (!updatedUser) {
      console.error("[Update] Failed to update user token");
      return null;
    }

    return updatedUser;
  } catch (error) {
    console.error("[getFirstItem Error]", {
      message: error?.message,
      url: error?.config?.url || "N/A",
      stack: error?.stack,
    });
    return null;
  }
}

async function getFirstItemTechnician(sender) {
  if (!sender || typeof sender !== "string") {
    console.error("[Validation] Invalid sender parameter:", sender);
    return null;
  }

  try {
      var jwt_token = jwt.sign({
      app: 'WhatsApp-Bot',
    }, process.env.JWT_SECRET, {
      expiresIn: '5m',
    });
    // Fetch user data
    const userResponse = await api.get(
      `${BASE_URL_WHATSAPP_LOGS}?loginPhone=${sender}`,
      {headers: { Authorization: `Bearer ${jwt_token}`,subdomain : "WhatsApp" }}
    );
    const responseData = userResponse?.data;

    if (
      !responseData?.status ||
      !Array.isArray(responseData.payload?.items) ||
      responseData.payload.items.length === 0
    ) {
      console.warn("[API] Invalid response structure or empty user list");
      return null;
    }

    return user = responseData.payload.items[0];
  } catch (error) {
    console.error("[getFirstItem Error]", {
      message: error?.message,
      url: error?.config?.url || "N/A",
      stack: error?.stack,
    });
    return null;
  }
}

async function refreshTechnician(accessToken, refreshToken) {
  // Validate tokens
  if (!accessToken || !refreshToken) {
    console.error("[Validation] Missing tokens for refresh");
    throw new Error("Missing authentication tokens");
  }

  try {
    const result = await api.post(
      BASE_URL_REFRESH_TECHNICIAN,
      {}, // Empty body
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          rtoken: refreshToken,
        },
        timeout: 10000, // 10 second timeout
      }
    );

    if (!result?.data) {
      console.error("[Refresh] Empty response from refresh endpoint");
      throw new Error("Empty refresh response");
    }

    return result.data;
  } catch (error) {
    console.error("[Refresh Error] Failed to refresh technician:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    throw error; // Re-throw to let caller handle
  }
}

// ========================
// Handlers
// ========================
const handleInteractiveMessage = async (
  replyId,
  replyTitle,
  phoneNumberId,
  sender,
  userData
) => {
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
    assignedOrders: "technician_assigned",
    pendingOrders: "pending_orders",
    wipOrders: "technician_working",
    partDetails: "part_details",
    completedOrders: "technician_work_completed",

    uploadDocument: "uploadDocument",
    verifyDocument: "verifyDocument",
  };

  const sendPartRequestForm = async (isAnotherPart, orderData, userData) => {
    const partTypeText = isAnotherPart ? "another part" : "a part";
    const formURL = `https://kumarvikasgit.github.io/technician-bot-forms/part-request?token=${userData.token}&id=${replyId.id}&orderId=${replyId.orderId}&sender=${sender}&phoneNoId=${phoneNumberId}&category=${orderData.category._id}&brand=${orderData.brand._id}&modelNo=${orderData.modelNo}&currentStatus=technician_working&userId=${userData.userId}&userName=${userData.userName}&anotherPart=${isAnotherPart}`;

    const message = `Make ${partTypeText} request\n\n1. Select Required from the Part List.\n2. Select the Part Provider.\n3. Select the Quantity.\n4. Add Serial number of the part.\n5. Upload photo of the part.\n\nAfter filling the details, add part(s) to the list and click "Send Part Request" to update the order.`;

    return await sendInteractiveCtaUrlMessage(
      phoneNumberId,
      sender,
      message,
      "Make Part Request",
      formURL
    );
  };

  const handleUpdateStatus = async () => {
    const statusCode = updateStatusMap[replyId.orderStatus];
    let orderData;
    if(replyId.id){
      orderData = await fetchOrderDetails(replyId.id, sender, userData);
      console.log("orderData", orderData.orderStatus.currentStatus);
      console.log("replyId", statusCode);

    if (statusCode === orderData.orderStatus.currentStatus) {
        await sendTextMessage(phoneNumberId, sender, "Status is Invalid");
       return await handleOrderStatusOptions(phoneNumberId, sender, orderData);
      }
    }

    switch (statusCode) {
      case "defective_pickup":
        return await sendInteractiveCtaUrlMessage(
          phoneNumberId,
          sender,
          "Please upload these required documents to continue:\n\n1. Defective Part Photo",
          "Upload Defective",
          `https://kumarvikasgit.github.io/technician-bot-forms/defective-pickup?token=${userData.token}&id=${replyId.id}&orderId=${replyId.orderId}&sender=${sender}&phoneNumberId=${phoneNumberId}`
        );

      case "parts_approval_pending":
        if (orderData.orderStatus.currentStatus === "technician_working"||orderData.orderStatus.currentStatus === "parts_approval_pending"||orderData.orderStatus.currentStatus === "defective_pickup") {
                return await sendPartRequestForm(false, orderData, userData);

        }
        await sendTextMessage(phoneNumberId, sender, "Status is Invalid");
        return await handleOrderStatusOptions(phoneNumberId, sender, orderData);
        
        
      case "another_parts_approval_pending":
        if (orderData.orderStatus.currentStatus !== "technician_working"||orderData.orderStatus.currentStatus !== "parts_approval_pending"||orderData.orderStatus.currentStatus !== "defective_pickup") {
           return await sendPartRequestForm(true, orderData, userData);

        }
        await sendTextMessage(phoneNumberId, sender, "Status is Invalid");
        return await handleOrderStatusOptions(phoneNumberId, sender, orderData);

      default:
        const status = MyOrderStatus.fromStatusCode(statusCode);
        return await updateOrderStatus(
          replyId,
          status,
          replyId.currentStatus,
          phoneNumberId,
          sender,
          orderData,
          userData
        );
    }
  };

  const handleOrderStatusMap = async () => {
    const mappedStatus = orderStatusMap[replyId.orderStatus];
     let orderData;
    if(replyId.id){
      orderData = await fetchOrderDetails(replyId.id, sender, userData);
    }

    if (mappedStatus === "uploadDocument") {
      if (orderData.orderStatus.currentStatus !== "technician_working") {
        return await sendTextMessage(
          phoneNumberId,
          sender,
          "Status is Invalid"
        );
      }

      const docUrl = `https://kumarvikasgit.github.io/technician-bot-forms/upload-document?token=${userData.token}&id=${replyId.id}&orderId=${replyId.orderId}&sender=${sender}&phoneNumberId=${phoneNumberId}`;
      const docMsg =
        "Please upload these required documents to continue:\n\n1. Device Photo\n2. Serial Number\n3. Invoice Photo\n\nPlease upload images with the names mentioned above.";
      return await sendInteractiveCtaUrlMessage(
        phoneNumberId,
        sender,
        docMsg,
        "Upload Document",
        docUrl
      );
    }

    return await sendOrderSections(
      mappedStatus,
      replyTitle,
      phoneNumberId,
      sender,
      userData
    );
  };

  try {
    if (updateStatusMap[replyId.orderStatus]) {
      return await handleUpdateStatus();
    }

    if (orderStatusMap[replyId.orderStatus]) {
      return await handleOrderStatusMap();
    }

    if (/^SRVZ-ORD-\d{9,10}$/i.test(replyTitle)) {
      const orderData = await fetchOrderDetails(replyId.id, sender, userData);
      if (replyId.orderStatus === "technician_work_completed") {
        return await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
      }
      return await handleOrderStatusOptions(phoneNumberId, sender, orderData);
    }

    return await sendTextMessage(
      phoneNumberId,
      sender,
      "Sorry, we couldn't process your selection."
    );
  } catch (error) {
    console.error("Error handling interactive message:", error);
    return await sendTextMessage(
      phoneNumberId,
      sender,
      "Something went wrong while processing your request."
    );
  }
};

// ========================
// Order Actions
// ========================
const updateOrderStatus = async (
  replyId,
  status,
  lastStatus,
  phoneNumberId,
  sender,
  orderData,
  userData
) => {
  const { user, documents, parts, brand } = orderData;

  if (status.statusCode === "technician_work_completed") {
    const isPartsRequest = parts !== undefined && parts.length > 0;
    const partsCount = isPartsRequest ? parts.length : 0;

    if (
      !isAllDocsValid(
        documents,
        brand?.name === "primebook",
        isPartsRequest,
        partsCount
      )
    ) {
      await sendTextMessage(
        phoneNumberId,
        sender,
        "Required documents not found please upload documents first then retry"
      );
      await handleOrderStatusOptions(phoneNumberId, sender, orderData);
      return;
    }
  }

  if (
    ["technician_accepted", "technician_rejected"].includes(
      status.statusCode
    ) &&
    !["technician_assigned", "technician_reassigned"].includes(
      orderData.orderStatus.currentStatus
    )
  ) {
    await sendTextMessage(phoneNumberId, sender, "Status is Not Valid");
    await handleOrderStatusOptions(phoneNumberId, sender, orderData);

    return;
  }

  if (
    status.statusCode === "technician_on_location" &&
    orderData.orderStatus.currentStatus !== "technician_accepted"
  ) {
    await sendTextMessage(phoneNumberId, sender, "Status is Not Valid");
    await handleOrderStatusOptions(phoneNumberId, sender, orderData);
    return;
  }

  if (
    status.statusCode === "technician_working" &&
    orderData.orderStatus.currentStatus !== "technician_on_location"
  ) {
    await sendTextMessage(phoneNumberId, sender, "Status is Not Valid");
    await handleOrderStatusOptions(phoneNumberId, sender, orderData);
    return;
  }

  if (
    status.statusCode === "technician_work_completed" &&
    !(orderData.orderStatus.currentStatus !== "technician_working" ||
      orderData.orderStatus.currentStatus !== "defective_pickup")

  ) {
    await sendTextMessage(phoneNumberId, sender, "Status is Not Valid");
    await handleOrderStatusOptions(phoneNumberId, sender, orderData);
    return;
  }

  try {
    const { data } = await api.post(
      BASE_URL_STATUS,
      {
        order: { orderId: replyId.orderId, _id: replyId.id },
        lastStatus,
        currentStatus: status.statusCode,
        state: status.state,
        statusChangeFrom: "technician",
        changeFrom: "technician",
        user: {
          _id: user._id,
          firstName: user.firstName,
          mobile: user.mobile,
          email: user.email,
        },
        agent: {
          _id: userData.userId,
          firstName: userData.userName,
          userName: userData.userName,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userData.token}`,
        },
      }
    );

    if (!data?.payload) throw new Error("Invalid API response");

    console.log("✅ Order status updated:", data.payload._id);

    // Inform user order updated
    await sendTextMessage(
      phoneNumberId,
      sender,
      "Order status updated successfully."
    );

    // Handle specific cases
    if (status.state === "technician_rejected") {
      await sendTextMessage(
        phoneNumberId,
        sender,
        "You no longer have access to this order."
      );
      return; // Stop further processing
    }

    if (status.state === "technician_work_completed") {
      await sendTextMessage(
        phoneNumberId,
        sender,
        "You have successfully completed your order. Say 'Hi' to start a new order."
      );
      return; // Stop further processing
    }

    // Otherwise, continue to fetch updated order details and show options
    const orderData = await fetchOrderDetails(
      data.payload.order._id,
      sender,
      userData
    );
    return await handleOrderStatusOptions(phoneNumberId, sender, orderData);
  } catch (error) {
    console.error(
      "❌ updateOrderStatus error:",
      error?.response?.data || error.message
    );
    return await sendTextMessage(
      phoneNumberId,
      sender,
      "Failed to update order status. Please try again later."
    );
  }
};

const sendOrderSections = async (
  status,
  replyTitle,
  phoneNumberId,
  sender,
  userData
) => {
  const sectionConfigs = {
    technician_assigned: [
      { title: "Assigned Orders", statusCode: "technician_assigned" },
      { title: "Reassigned Orders", statusCode: "technician_reassigned" },
    ],
    pending_orders: [
      { title: "Accepted Orders", statusCode: "technician_accepted" },
      { title: "Defective Pickup", statusCode: "defective_pickup" },
    ],
    technician_working: [
      { title: "Reached Location", statusCode: "technician_on_location" },
      { title: "Work in Progress", statusCode: "technician_working" },
    ],
    part_details: [
      { title: "Part Pending", statusCode: "parts_approval_pending" },
      { title: "Defective Pickup", statusCode: "defective_pickup" },
    ],
    technician_work_completed: [
      { title: "Completed Orders", statusCode: "technician_work_completed" },
      { title: "Complaint Resolved", statusCode: "complaint_resolved" },
      { title: "Order Resolved", statusCode: "sc_order_resolved" },
    ],
  };

  if (sectionConfigs[status]) {
    const sections = [];

    for (const config of sectionConfigs[status]) {
      const orders = await fetchOrdersByStatus(
        config.statusCode,
        sender,
        userData
      );
      if (orders.length > 0) {
        sections.push({ title: config.title, rows: orders });
      }
    }

    if (sections.length === 0) {
      await sendTextMessage(
        phoneNumberId,
        sender,
        "Currently you have no orders to show. Please check after some time."
      );
      return;
    }

    return await sendInteractiveList(
      phoneNumberId,
      sender,
      replyTitle,
      sections
    );
  } else {
    const orders = await fetchOrdersByStatus(status, sender, userData);
    if (orders.length === 0) {
      return await sendTextMessage(
        phoneNumberId,
        sender,
        "No orders found at this time."
      );
    } else {
      return await sendInteractiveList(phoneNumberId, sender, replyTitle, [
        { title: replyTitle, rows: orders },
      ]);
    }
  }
};

const fetchOrdersByStatus = async (status, sender, userData) => {
  let limit = 5;

  if (
    status === "technician_work_completed" ||
    status === "complaint_resolved" ||
    status === "sc_order_resolved"
  ) {
    limit = 3;
  }

  try {
    const { data } = await api.get(
      `${BASE_URL_ORDERS}?orderStatus=${status}&technician=${userData.userId}&limit=${limit}`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userData.token}`,
        },
      }
    );
    return formatOrdersList(data?.payload?.items || []);
  } catch (error) {
    console.error(
      "❌ fetchOrdersByStatus error:",
      error?.response?.data || error.message
    );
    return [];
  }
};

const fetchOrdersByOrderId = async (orderID, userData) => {
  try {
    const { data } = await api.get(
      `${BASE_URL_ORDERS}?orderId=${orderID}&technician=${userData.userId}&limit=10`,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userData.token}`,
        },
      }
    );
    return formatOrdersList(data?.payload?.items || []);
  } catch (error) {
    console.error(
      "❌ fetchOrdersByStatus error:",
      error?.response?.data || error.message
    );
    return [];
  }
};

const fetchOrderDetails = async (id, sender, userData) => {
  const { data } = await api.get(`${BASE_URL_ORDERS}/${id}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userData.token}`,
    },
  });
  return data?.payload;
};

const handleOrderStatusOptions = async (phoneNumberId, sender, orderData) => {
  if (
    !orderData ||
    !orderData.orderStatus ||
    !orderData.orderStatus.currentStatus
  ) {
    console.warn("⚠️ Missing or invalid order status data:", orderData);
    return await sendTextMessage(
      phoneNumberId,
      sender,
      "⚠️ Unable to display options due to missing order status."
    );
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
    return await sendTextMessage(
      phoneNumberId,
      sender,
      `Order Id: ${orderData.orderId}\nℹ️ Current Status: ${orderStatus.state}. No actions available at this time.`
    );
  }

  const buttons = options.map((opt) => ({
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

  return await sendInteractiveButtons(
    phoneNumberId,
    sender,
    orderData,
    buttons
  );
};

// ========================
// Message Builders
// ========================
const sendTextMessage = (phoneNumberId, to, message) =>
  axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: message },
    }
  );

const sendInteractiveOptions = (phoneNumberId, to, userData) =>
  axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: `Hi ${
            userData?.userName ?? ""
          }, welcome to SERVIZ Technician Bot.`,
        },
        body: { text: "Please choose an option, Or Enter Order Id to search order Ex. SRVZ-ORD-123XXXXXXX." },
        action: {
          button: "Get Orders",
          sections: [
            {
              title: "Options",
              rows: [
                {
                  id: createCustomId({ orderStatus: "assignedOrders" }),
                  title: "Assigned Orders",
                  description: "Not yet started.",
                },
                {
                  id: createCustomId({ orderStatus: "pendingOrders" }),
                  title: "Pending Orders",
                  description: "Not yet started.",
                },
                {
                  id: createCustomId({ orderStatus: "wipOrders" }),
                  title: "WIP Orders",
                  description: "In progress.",
                },
                {
                  id: createCustomId({ orderStatus: "partDetails" }),
                  title: "Part Details",
                  description: "Part Request & Defective Pickup.",
                },
                {
                  id: createCustomId({ orderStatus: "completedOrders" }),
                  title: "Completed Orders",
                  description: "Finished.",
                },
              ],
            },
          ],
        },
      },
    }
  );

const sendInteractiveList = (phoneNumberId, to, title, sections) =>
  axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: title },
        body: { text: `Here are your ${title}.` },
        action: { button: "View Orders", sections },
      },
    }
  );

const sendInteractiveButtons = (phoneNumberId, to, orderData, buttons) => {
  const {
    orderId,
    category,
    subCategory,
    serviceDateTime,
    user,
    address,
    orderStatus,
    serialNo,
    modelNo,
    serviceComment,
  } = orderData;
  const schedule = new Date(serviceDateTime).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });

  return axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: `Order ID: ${orderId}` },
        body: {
          text: `📦 Order Details\n\n🆔 Status: ${orderStatus.state}\n📅 Schedule: ${schedule}\n\n🔧 Appliance: ${category?.name} - ${subCategory?.name}\nSerial Number: ${serialNo}\nModel Number: ${modelNo}\nIssue: ${serviceComment}\n\n👤 Customer: ${user?.firstName}\n📞Phone No: ${user?.mobile}\n📍 Address: ${address?.address}, ${address?.city} - ${address.pincode}`,
        },
        action: { buttons },
      },
    }
  );
};

const sendInteractiveCtaUrlMessage = (
  phoneNumberId,
  to,
  bodyText,
  buttonText,
  buttonUrl
) => {
  return axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
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
          text: bodyText,
        },
        // footer: {
        //   text: footerText
        // },
        action: {
          name: "cta_url",
          parameters: {
            display_text: buttonText,
            url: buttonUrl,
          },
        },
      },
    }
  );
};

const sendOrderDetailsSummary = async (orderData, phoneNumberId, sender) => {
  const schedule = new Date(orderData.serviceDateTime).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });
  await sendTextMessage(
    phoneNumberId,
    sender,
    `📦 *Order Details*\n\n🆔 *Status:* ${orderData.orderStatus.state}\n📅 *Schedule:* ${schedule}\n\n🔧 *Appliance:* ${orderData.category?.name} - ${orderData.subCategory?.name}\n• Issue: ${orderData.pkg?.issue}\n\n👤 *Customer:* ${orderData.user?.firstName}\n• ${orderData.address?.address}, ${orderData.address?.city}\n• 📞 ${orderData.user?.mobile}`
  );
};

// Format Orders List
const formatOrdersList = (orders = []) =>
  orders.map((order) => ({
    id: createCustomId({
      orderStatus: order.orderStatus?.currentStatus,
      orderId: order.orderId,
      id: order._id,
    }),
    title: order.orderId,
    description: `${order.category?.name || ""} - ${
      order.subCategory?.name || ""
    } | ${order.brand?.name || ""} | ${order.warranty || ""} | ${
      order.serviceComment || ""
    }`,
  }));

async function getUserState(sender) {
  return userStore[sender]?.state || "initial";
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
    console.error("Error sending OTP:", error.message || error);
    await sendTextMessage(
      phoneNumberId,
      sender,
      `❌ Failed to send OTP: Please try again later`
    );
    throw error; // rethrow to allow the caller to know it failed
  }
}

async function verifyOTP(otp, phone, sender) {
  try {
    const { data } = await api.post(
      `${BASE_URL_SC}employee-login-otp/confirm`,
      {
        mobile: phone,
        otp: otp,
      }
    );

    const userData = await getFirstItem(sender);

    if (userData) {
      await api.put(`${BASE_URL_WHATSAPP_LOGS}/${userData._id}`, {
        userPhoneId: sender,
        userName: data.payload.userName,
        userId: data.payload.userId,
        token: data.payload.token,
        rToken: data.payload.refreshToken,
        loginPhone: phone,
      }
      ,{headers: { Authorization: `Bearer ${data.payload.token}` }});

      return data.status;
    }

    await api.post(BASE_URL_WHATSAPP_LOGS, {
      userPhoneId: sender,
      userName: data.payload.userName,
      userId: data.payload.userId,
      token: data.payload.token,
      rToken: data.payload.refreshToken,
      loginPhone: phone,
    },{headers: { Authorization: `Bearer ${data.payload.token}` }});

    return data.status;
  } catch (error) {
    console.error("Error verifying OTP:", error.message || error);
    return false;
  }
}

const validateDocuments = (docs, validations) => {
  if (!docs || docs.length === 0) return false;

  const counts = Array(9).fill(0); // Size 9 to accommodate type 8
  docs.forEach((doc) => counts[doc.type?.value ?? DOCUMENT_TYPES.DEFAULT]++);

  return validations.every(({ type, minCount }) => counts[type] >= minCount);
};

const isAllDocsValid = (
  docs,
  isPrimeBookOrder,
  isPartRequest,
  partQuantity
) => {
  const validations = [
    { type: DOCUMENT_TYPES.INVOICE, minCount: 1 },
    { type: DOCUMENT_TYPES.SERIAL_NUMBER, minCount: 1 },
    { type: DOCUMENT_TYPES.DEVICE_PHOTO, minCount: 1 },
  ];

  if (isPrimeBookOrder) {
    validations.push({ type: DOCUMENT_TYPES.SELFIE, minCount: 1 });
  }

  if (isPartRequest) {
    validations.push({
      type: DOCUMENT_TYPES.DEFECTIVE_PICKUP,
      minCount: 1,
    });
  }

  return validateDocuments(docs, validations);
};

const isCorpDocsValid = (docs, isAc, isPartRequest, partQuantity) => {
  return validateDocuments(docs, [
    { type: DOCUMENT_TYPES.SERIAL_NUMBER, minCount: 1 },
    { type: DOCUMENT_TYPES.DEVICE_PHOTO, minCount: 1 },
    {
      type: DOCUMENT_TYPES.OUTER_SERIAL_NUMBER,
      minCount: 1,
      condition: isAc,
    },
    {
      type: DOCUMENT_TYPES.DEVICE_PHOTO,
      minCount: 1,
      condition: isAc,
    },
    {
      type: DOCUMENT_TYPES.DEFECTIVE_PART,
      minCount: partQuantity,
      condition: isPartRequest,
    },
  ]);
};

app.post("/notify-document-upload", cors(), async (req, res) => {
  try {
    const { id, orderID, sender, status, phoneNumberId } = req.body;

    console.log(
      "📥 Received document upload request:",
      JSON.stringify(req.body, null, 2)
    );

    // Validate presence of required fields
    const missingFields = [];
    if (!id) missingFields.push("id");
    if (!orderID) missingFields.push("orderID");
    if (!sender) missingFields.push("sender");
    if (!phoneNumberId) missingFields.push("phoneNumberId");

    if (missingFields.length > 0) {
      const errorMsg = `⚠️ Missing required fields: ${missingFields.join(
        ", "
      )}`;
      console.warn(errorMsg);
      return res.status(400).json({ status: false, message: errorMsg });
    }

    // Proceed only if status is true
    if (status === true) {
      try {
        let userData = await getFirstItem(sender);
        // 1. Acknowledge successful upload
        await sendTextMessage(
          phoneNumberId,
          sender,
          `✅ Document uploaded successfully for Order ${orderID}.`
        );

        // 2. Fetch order details
        const orderData = await fetchOrderDetails(id, sender, userData);

        if (!orderData) {
          const msg =
            "⚠️ Document uploaded, but order data could not be found.";
          console.warn(msg);
          await sendTextMessage(phoneNumberId, sender, msg);
          return res.status(200).json({ status: true, message: msg });
        }

        // 3. If work completed, send order summary
        if (
          orderData.orderStatus?.currentStatus === "technician_work_completed"
        ) {
          await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
          return res
            .status(200)
            .json({
              status: true,
              message: "Summary sent after work completion.",
            });
        }

        // 4. Otherwise, show next order status options
        await handleOrderStatusOptions(phoneNumberId, sender, orderData);
        return res
          .status(200)
          .json({
            status: true,
            message: "Options sent based on order status.",
          });
      } catch (fetchError) {
        console.error("❌ Error during order handling:", fetchError.message);
        await sendTextMessage(
          phoneNumberId,
          sender,
          "⚠️ Upload successful, but failed to process order."
        );
        return res
          .status(500)
          .json({
            status: false,
            message: "Failed to process order after upload.",
          });
      }
    }

    return res
      .status(200)
      .json({
        status: true,
        message: "Upload acknowledged without status = true.",
      });
  } catch (error) {
    console.error("🔥 Unexpected error in /document-upload:", error);
    return res
      .status(500)
      .json({ status: false, message: "Internal Server Error" });
  }
});

app.post("/notify-part-update", cors(), async (req, res) => {
  try {
    const { id, orderID, sender, status, phoneNumberId } = req.body;

    console.log(
      "📥 Received part update request:",
      JSON.stringify(req.body, null, 2)
    );

    // Validate presence of required fields
    const missingFields = [];
    if (!id) missingFields.push("id");
    if (!orderID) missingFields.push("orderID");
    if (!sender) missingFields.push("sender");
    if (!phoneNumberId) missingFields.push("phoneNumberId");

    if (missingFields.length > 0) {
      const errorMsg = `⚠️ Missing required fields: ${missingFields.join(
        ", "
      )}`;
      console.warn(errorMsg);
      return res.status(400).json({ status: false, message: errorMsg });
    }

    // Proceed only if status is true
    if (status === true) {
      try {
        let userData = await getFirstItem(sender);
        // 1. Acknowledge successful upload
        await sendTextMessage(
          phoneNumberId,
          sender,
          `✅ We receive part update request for Order ${orderID}.`
        );

        // 2. Fetch order details
        const orderData = await fetchOrderDetails(id, sender, userData);

        if (!orderData) {
          const msg = "⚠️ Part Updated, but order data could not be found.";
          console.warn(msg);
          await sendTextMessage(phoneNumberId, sender, msg);
          return res.status(200).json({ status: true, message: msg });
        }

        // 3. If work completed, send order summary
        if (
          orderData.orderStatus?.currentStatus === "technician_work_completed"
        ) {
          await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
          return res
            .status(200)
            .json({
              status: true,
              message: "Summary sent after work completion.",
            });
        }

        // 4. Otherwise, show next order status options
        await handleOrderStatusOptions(phoneNumberId, sender, orderData);
        return res
          .status(200)
          .json({
            status: true,
            message: "Options sent based on order status.",
          });
      } catch (fetchError) {
        console.error("❌ Error during order handling:", fetchError.message);
        await sendTextMessage(
          phoneNumberId,
          sender,
          "⚠️ Upload successful, but failed to process order."
        );
        return res
          .status(500)
          .json({
            status: false,
            message: "Failed to process order after upload.",
          });
      }
    }

    return res
      .status(200)
      .json({
        status: true,
        message: "Upload acknowledged without status = true.",
      });
  } catch (error) {
    console.error("🔥 Unexpected error in /document-upload:", error);
    return res
      .status(500)
      .json({ status: false, message: "Internal Server Error" });
  }
});

app.post("/notify-defective-part-update", cors(), async (req, res) => {
  try {
    const { id, orderID, sender, status, phoneNumberId } = req.body;

    console.log(
      "📥 Received defective part update request:",
      JSON.stringify(req.body, null, 2)
    );

    // Validate presence of required fields
    const missingFields = [];
    if (!id) missingFields.push("id");
    if (!orderID) missingFields.push("orderID");
    if (!sender) missingFields.push("sender");
    if (!phoneNumberId) missingFields.push("phoneNumberId");

    if (missingFields.length > 0) {
      const errorMsg = `⚠️ Missing required fields: ${missingFields.join(
        ", "
      )}`;
      console.warn(errorMsg);
      return res.status(400).json({ status: false, message: errorMsg });
    }

    // Proceed only if status is true
    if (status === true) {
      try {
        let userData = await getFirstItem(sender);
        // 1. Acknowledge successful upload
        await sendTextMessage(
          phoneNumberId,
          sender,
          `✅ We receive defective part update request for Order ${orderID}.`
        );

        // 2. Fetch order details
        const orderData = await fetchOrderDetails(id, sender, userData);

        if (!orderData) {
          const msg = "⚠️ Part Updated, but order data could not be found.";
          console.warn(msg);
          await sendTextMessage(phoneNumberId, sender, msg);
          return res.status(200).json({ status: true, message: msg });
        }

        // 3. If work completed, send order summary
        if (
          orderData.orderStatus?.currentStatus === "technician_work_completed"
        ) {
          await sendOrderDetailsSummary(orderData, phoneNumberId, sender);
          return res
            .status(200)
            .json({
              status: true,
              message: "Summary sent after work completion.",
            });
        }

        // 4. Otherwise, show next order status options
        await handleOrderStatusOptions(phoneNumberId, sender, orderData);
        return res
          .status(200)
          .json({
            status: true,
            message: "Options sent based on order status.",
          });
      } catch (fetchError) {
        console.error("❌ Error during order handling:", fetchError.message);
        await sendTextMessage(
          phoneNumberId,
          sender,
          "⚠️ Upload successful, but failed to process order."
        );
        return res
          .status(500)
          .json({
            status: false,
            message: "Failed to process order after upload.",
          });
      }
    }

    return res
      .status(200)
      .json({
        status: true,
        message: "Upload acknowledged without status = true.",
      });
  } catch (error) {
    console.error("🔥 Unexpected error in /document-upload:", error);
    return res
      .status(500)
      .json({ status: false, message: "Internal Server Error" });
  }
});

app.post("/notify-order-assigned", cors(), async (req, res) => {
  try {
    const { technicianPhone, orderId, phoneNumberId } = req.body;

    // Validate presence of required fields
    const missingFields = [];
    if (!technicianPhone) missingFields.push("technicianPhone");
    if (!orderId) missingFields.push("orderID");
    if (!phoneNumberId) missingFields.push("orderID");

    if (missingFields.length > 0) {
      const errorMsg = `⚠️ Missing required fields: ${missingFields.join(
        ", "
      )}`;
      console.warn(errorMsg);
      return res.status(400).json({ status: false, message: errorMsg });
    }

        let userData = await getFirstItemTechnician(technicianPhone);
        // 1. Acknowledge successful upload

        if(userData){
 await sendTextMessage(
          phoneNumberId,
          userData.userPhoneId,
          `Hi, ${userData.userName}, New order has been assigned to you: ${orderId}.`
        );
        return res.status(200).json({ status: true, message: "Notification sent to technician" });
        }else{
        return res.status(200).json({ status: false, message: "Technician not found or not logged in." });
        }
      

  } catch (error) {
    console.error("🔥 Unexpected error in /notify-technician-order-assigned:", error);
    return res
      .status(500)
      .json({ status: false, message: "Internal Server Error" });
  }
});

app.post("/notify-part-request-update", cors(), async (req, res) => {
  try {
    const { technicianPhone, orderId, phoneNumberId } = req.body;

    // Validate presence of required fields
    const missingFields = [];
    if (!technicianPhone) missingFields.push("technicianPhone");
    if (!orderId) missingFields.push("orderID");
    if (!phoneNumberId) missingFields.push("orderID");

    if (missingFields.length > 0) {
      const errorMsg = `⚠️ Missing required fields: ${missingFields.join(
        ", "
      )}`;
      console.warn(errorMsg);
      return res.status(400).json({ status: false, message: errorMsg });
    }

        let userData = await getFirstItemTechnician(technicianPhone);
        // 1. Acknowledge successful upload

        if(userData){
 await sendTextMessage(
          phoneNumberId,
          userData.userPhoneId,
          `Hi, ${userData.userName}, Part Request has been updated for your OrderId: ${orderId}.`
        );
        return res.status(200).json({ status: true, message: "Notification sent to technician" });
        }else{
        return res.status(200).json({ status: false, message: "Technician not found or not logged in." });
        }
      

  } catch (error) {
    console.error("🔥 Unexpected error in /notify-technician-order-assigned:", error);
    return res
      .status(500)
      .json({ status: false, message: "Internal Server Error" });
  }
});
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { Status, MyOrderStatus } = require("./order_status");
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
  PORT = 3000,
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
    Authorization: AUTH_TOKEN,
  },
});

// ID Helpers
const createCustomId = (data = {}) => {
  const idString = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null) // ❗ skip undefined/null
    .map(([k, v]) => `${k}:${encodeURIComponent(v)}`) // ❗ safe encoding
    .join("|");

  console.log("🛠 Created Custom ID:", idString); // << Log created ID
  return idString;
};

const parseCustomId = (idString = "") => {
  const parsed = idString.split("|").reduce((acc, part) => {
    const separatorIndex = part.indexOf(":");
    if (separatorIndex > -1) {
      const key = part.slice(0, separatorIndex);
      const value = part.slice(separatorIndex + 1);
      if (key) acc[key] = decodeURIComponent(value); // ❗ safe decoding
    }
    return acc;
  }, {});

  console.log("🛠 Parsed Custom ID:", parsed); // << Log parsed ID
  return parsed;
};

// Webhook verification
app.get("/webhook", (req, res) => {
  const {
    "hub.mode": mode,
    "hub.challenge": challenge,
    "hub.verify_token": token,
  } = req.query;
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
      const listReply =
        message?.interactive?.list_reply || message?.interactive?.button_reply;
      const replyId = parseCustomId(listReply?.id);
      const replyTitle = listReply?.title;

      //   console.log("id: "+replyId.id);
      console.log("status: " + replyId.orderStatus);

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
        const st1 = MyOrderStatus.fromStatusCode(
          updateStatusMap[replyId.orderStatus]
        );

        await updateOrderStatus(replyId, st1, replyId.currentStatus);
        return res.sendStatus(200);
      }

      if (orderStatusMap[replyId.orderStatus]) {

        if(replyId.orderStatus==="technician_working"){
            const wipOrders = await fetchOrdersByStatus(
                "technician_working"
              );

              const reachedLocation = await fetchOrdersByStatus(
                "technician_on_location"
              );
            
              const partPending = await fetchOrdersByStatus(
                "parts_approval_pending"
              );
            
              const partHandoverToTechnician = await fetchOrdersByStatus(
                "parts_handover_to_tecnician"
              );

              const defectivePickup = await fetchOrdersByStatus(
                "defective_pickup"
              );
            

        }

        const formattedOrders = await fetchOrdersByStatus(
          orderStatusMap[replyId.orderStatus]
        );

        // Check if formattedOrders is empty
        if (formattedOrders.length === 0) {
          await sendTextMessage(
            phoneNumberId,
            sender,
            `Currently you have no orders in queue, try again after some time.`
          );
          return res.status(200).send({ success: true }); // Return a successful response after sending the message
        }

        await sendInteractiveOrderList(
          phoneNumberId,
          sender,
          replyTitle,
          formattedOrders
        );
        return res.status(200).send({ success: true });
      }

      if (orderPattern.test(replyTitle)) {
        console.log("orddder id " + replyId.id);
        const orderData = await fetchOrderDetails(replyId.id);

        if (replyId.orderStatus === "technician_work_completed") {
          const formattedDate = new Date(
            orderData.serviceDateTime
          ).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });

          await sendTextMessage(
            phoneNumberId,
            sender,
            `📦 *Order Details*\n\n🆔 *Status:* ${orderData.orderStatus.state}\n📅 *Schedule:* ${formattedDate}\n\n🔧 *Appliance*\n• ${orderData.category?.name} - ${orderData.subCategory?.name}\n• Issue: ${orderData.pkg?.issue}\n\n👤 *Customer*\n• ${orderData.user?.firstName}\n• ${orderData.address?.address}, ${orderData.address?.city}\n• 📞 ${orderData.user?.mobile}`
          );
          return res.sendStatus(200);
        }

        await handleOrderStatus(phoneNumberId, sender, orderData);
        return res.sendStatus(200);
      } else {
        await sendTextMessage(
          phoneNumberId,
          sender,
          `We unable to process your request this time please try again.`
        );
        return res.sendStatus(200);
      }
    }

    await sendInteractiveOptions(phoneNumberId, sender);
    res.sendStatus(200);
  } catch (error) {
    await sendTextMessage(
      phoneNumberId,
      sender,
      `We unable to process your request this time please try again.`
    );
    if (error.response) {
      console.error("❌ Webhook Error Response:");
      console.error("Status:", error.response.status);
      console.error("Data:", JSON.stringify(error.response.data, null, 2));
    } else {
      console.error("❌ Webhook General Error:", error.message);
    }
    res.sendStatus(500);
  }
});

// ================================
// 🚀 Utility Functions
// ================================

// Update Order Status
const updateOrderStatus = async (replyId, currentStatus, lastStatus) => {
  var data = {
    order: {
      orderId: replyId.orderId,
      _id: replyId.id,
    },
    lastStatus: lastStatus,
    statusChangeFrom: "admin",
    changeFrom: "admin",
    currentStatus: currentStatus.statusCode,
    state: currentStatus.state,
    user: {
      _id: "6464bf7e4f51a5937348796f",
      email: "9934012217@serviz.com",
      firstName: "Rahul",
    },
  };

  console.log("cccccc" + JSON.stringify(data));

  try {
    const response = await api.post(BASE_URL_STATUS, {
      order: {
        orderId: replyId.orderId,
        _id: replyId.id,
      },
      lastStatus: lastStatus,
      statusChangeFrom: "admin",
      changeFrom: "admin",
      currentStatus: currentStatus.statusCode,
      state: currentStatus.state,
      user: {
        _id: "6464bf7e4f51a5937348796f",
        email: "9934012217@serviz.com",
        firstName: "Rahul",
      },
    });
    console.log("✅ updateOrderStatus - Success:", response.data);
  } catch (error) {
    console.error(
      "❌ updateOrderStatus - Error:",
      error?.response?.data || error.message
    );
    throw error;
  }
};

// Fetch orders by status
const fetchOrdersByStatus = async (status) => {
  try {
    console.log(`📥 Fetching orders for status: ${status}`);

    const response = await api.get(
      `${BASE_URL_ORDERS}?orderStatus=${status}&technician=${TECHNICIAN}`
    );

    console.log(
      "✅ Orders fetched successfully:",
      JSON.stringify(response.data?.payload, null, 2)
    );

    return formatOrdersList(response.data);
  } catch (error) {
    console.error("❌ Error fetching orders by status:", {
      message: error.message,
      url: `${BASE_URL_ORDERS}?orderStatus=${status}&technician=${TECHNICIAN}`,
      responseData: error.response?.data || "No response data",
      stack: error.stack,
    });
    return []; // 🔥 Return empty list safely on error
  }
};

// Fetch specific order details
const fetchOrderDetails = async (id) => {
  const response = await api.get(`${BASE_URL_ORDERS}/${id}`);
  return response.data?.payload;
};

// Handle interactive buttons based on order status
const handleOrderStatus = async (phoneNumberId, sender, orderData) => {
  if (!orderData)
    throw new Error("❌ No order data found in handleOrderStatus");

  const { orderStatus, orderId, _id } = orderData;

  const optionsMap = {
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
      { status: "makePartRequest", title: "Make Part Request" },
      { status: "makeMarkComplete", title: "Mark Work Complete" },
    ],
  };

  const options =
    optionsMap[orderStatus.currentStatus]?.map((opt) => ({
      type: "reply",
      reply: {
        id: createCustomId({
          orderStatus: opt.status,
          orderId,
          id: _id,
          currentStatus: orderStatus.currentStatus,
        }),
        title: opt.title,
      },
    })) || [];

  console.log(
    "🛠 handleOrderStatus - Generated Options:",
    JSON.stringify(options, null, 2)
  ); // 👈 log the buttons

  await sendInteractiveOrderDetails(phoneNumberId, sender, orderData, options);
};

// Format order list
const formatOrdersList = (data) => {
  console.log(
    "📦 Raw order data:",
    JSON.stringify(data?.payload?.items, null, 2)
  );

  const formattedOrders =
    data?.payload?.items?.map((item) => {
      const customId = createCustomId({
        orderStatus: item.orderStatus?.currentStatus,
        orderId: item.orderId,
        id: item._id,
      });

      console.log("🛠 Created ID for order:", {
        orderId: item.orderId,
        id: item._id,
        customId,
      });

      return {
        id: customId,
        title: item.orderId,
        description: `${item.category?.name || ""} - ${
          item.subCategory?.name || ""
        } | ${item.brand?.name || ""} | ${item.warranty || ""} | ${
          item.serviceComment || ""
        }`,
      };
    }) || [];

  console.log("✅ Formatted orders:", JSON.stringify(formattedOrders, null, 2));

  return formattedOrders;
};

// Send simple text message
const sendTextMessage = (phoneNumberId, to, message) =>
  axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: message },
    }
  );

// Updated: sendInteractiveOptions
const sendInteractiveOptions = (phoneNumberId, to) =>
  axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: `Hi ${to}, welcome to SERVIZ Technician BOT.`,
        },
        body: { text: "Please select an option to continue" },
        action: {
          button: "Get Orders by Status",
          sections: [
            {
              title: "Your Options",
              rows: [
                {
                  id: createCustomId({ orderStatus: "pendingOrders" }),
                  title: "Pending Orders",
                  description: "Not started yet.",
                },
                {
                  id: createCustomId({ orderStatus: "wipOrders" }),
                  title: "WIP Orders",
                  description: "In progress.",
                },
                {
                  id: createCustomId({ orderStatus: "completedOrders" }),
                  title: "Completed Orders",
                  description: "Recently completed.",
                },
              ],
            },
          ],
        },
      },
    }
  );

// Send orders list
const sendInteractiveOrderList = (phoneNumberId, to, title, orders = []) =>
  axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: title },
        body: {
          text: `Here are the ${title.toLowerCase()} orders. Tap below.`,
        },
        action: {
          button: "View Orders",
          sections: [{ title, rows: orders }],
        },
      },
    }
  );

// Send detailed order view with buttons
const sendInteractiveOrderDetails = (
  phoneNumberId,
  to,
  orderData,
  options = []
) => {
  const {
    orderId,
    category,
    subCategory,
    package: pkg,
    serviceDateTime,
    user,
    address,
    orderStatus,
  } = orderData;
  const formattedDate = new Date(serviceDateTime).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return axios.post(
    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${TOKEN}`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: `Order ID: ${orderId}` },
        body: {
          text: `📦 *Order Details*\n\n🆔 *Status:* ${orderStatus.state}\n📅 *Schedule:* ${formattedDate}\n\n🔧 *Appliance*\n• ${category?.name} - ${subCategory?.name}\n• Issue: ${pkg?.issue}\n\n👤 *Customer*\n• ${user?.firstName}\n• ${address?.address}, ${address?.city}\n• 📞 ${user?.mobile}`,
        },
        footer: { text: "Select below to proceed" },
        action: { buttons: options },
      },
    }
  );
};

// Default home route
app.get("/", (req, res) =>
  res.status(200).send("✅ WhatsApp Webhook Setup Working!")
);

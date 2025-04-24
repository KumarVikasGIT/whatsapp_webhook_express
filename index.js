const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const token = process.env.TOKEN;
const verifyToken = process.env.MYTOKEN;
const orderPattern = /^SRVZ-ORD-\d{6}$/i;
const actionPattern = /^accept\d+$/;
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Webhook server is listening on port ${PORT}`);
});

// Verify the webhook setup
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const token = req.query["hub.verify_token"];

    if (mode && token && mode === "subscribe" && token === verifyToken) {
        console.log("Webhook verified successfully.");
        return res.status(200).send(challenge);
    }
    console.warn("Webhook verification failed.");
    res.sendStatus(403);
});

// Handle incoming messages
app.post("/webhook", async (req, res) => {
    const body = req.body;
    console.log("📩 Received webhook event:", JSON.stringify(body, null, 2));

    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    const metadata = entry?.metadata;
    const contact = entry?.contacts?.[0];
    const messageType = message?.type;

    if (!body.object || !message || !metadata || !contact) {
        console.warn("⚠️ Invalid webhook structure");
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

            // Action Handler (e.g. accept1)
            if (actionPattern.test(replyId)) {
                await sendTextMessage(phoneNumberId, sender, `We got your request and updated your order status...\nPlease message \"Hello\" or \"Hi\" to start a new conversation.`);
                return res.sendStatus(200);
            }

            // Order ID Handler
            if (orderPattern.test(replyTitle)) {
                await sendInteractiveOrderDetails(phoneNumberId, sender, replyTitle);
                return res.sendStatus(200);
            }

            // Order Status Section Response
            await sendInteractiveOrderList(phoneNumberId, sender, replyTitle);
            return res.sendStatus(200);
        }

        // Fallback for non-interactive messages
        await sendInteractiveOptions(phoneNumberId, sender);
        res.sendStatus(200);

    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error.message);
        res.sendStatus(500);
    }
});

// Utilities
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

const sendInteractiveOrderList = async (phoneNumberId, to, title) => {
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
                            rows: [
                                { id: "orderID", title: "SRVZ-ORD-738762", description: "Order Assigned" },
                                { id: "orderID1", title: "SRVZ-ORD-738800", description: "Order Assigned" },
                                { id: "orderID2", title: "SRVZ-ORD-738801", description: "Order Assigned" },
                            ]
                        }
                    ]
                }
            }
        },
        { headers: { "Content-Type": "application/json" } }
    );
};

const sendInteractiveOrderDetails = async (phoneNumberId, to, orderId) => {
    await axios.post(
        `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
        {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "interactive",
            interactive: {
                type: "list",
                header: { type: "text", text: `Order ID: ${orderId}` },
                body: {
                    text: `📦 Order Details\n\n🆔 Current Status: Technician Assigned\n📅 Schedule: 12 July 2023, 12:22\n\n🔧 Appliance\n• Category: Air Conditioner\n• Subcategory: Split AC\n• Issue: Not cooling\n\n👤 Customer\n• Name: Vikas Kumar\n• Address: Delhi\n• Phone: 8826095638`
                },
                footer: { text: "Click for more options to Accept, Reject or Change Status" },
                action: {
                    button: "More Options",
                    sections: [
                        {
                            title: "Your Options",
                            rows: [
                                { id: "accept1", title: "Accept Order", description: "Start your work." },
                                { id: "accept2", title: "Reject Order", description: "Release this order." }
                            ]
                        }
                    ]
                }
            }
        },
        { headers: { "Content-Type": "application/json" } }
    );
};

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

// Default route
app.get("/", (req, res) => {
    res.status(200).send("Hello, this is the WhatsApp webhook setup!");
});
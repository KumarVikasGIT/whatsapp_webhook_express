const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const token = process.env.TOKEN;
const verifyToken = process.env.MYTOKEN;
const pattern2= /^accept\d+$/;

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Webhook server is listening on port ${PORT}`);
});

// Verify the webhook setup (for Facebook/Meta Cloud API)
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const token = req.query["hub.verify_token"];

    if (mode && token) {
        if (mode === "subscribe" && token === verifyToken) {
            console.log("Webhook verified successfully.");
            return res.status(200).send(challenge);
        } else {
            console.warn("Webhook verification failed: Token mismatch");
            return res.sendStatus(403);
        }
    }
    res.sendStatus(403);
});

// Handle incoming messages
app.post("/webhook", async (req, res) => {
    const body = req.body;
    console.log("📩 Received webhook event:");

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const metadata = body.entry?.[0]?.changes?.[0]?.value?.metadata;
    const contact = body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];
    const messageType = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0].type;

    if (!body.object || !message || !metadata || !contact) {
        console.warn("⚠️ Invalid webhook structure");
        console.warn(body);
        return res.sendStatus(404);
    }

    const phoneNumberId = metadata.phone_number_id;
    const sender = message.from;
    const text = message.text?.body?.trim() || "";
    const lowerText = text.toLowerCase();
    const senderName = contact.profile?.name || "Unknown";

    console.log("📞 Phone number ID:", phoneNumberId);
    console.log("👤 Sender:", sender);
    console.log("🧾 Message body:", text);
    console.log("📛 Sender name:", senderName);
    console.log("📛 Message Type:", messageType);

    // RegEx pattern for Order ID
    const orderPattern = /^SRVZ-ORD-\d{6}$/i;

    try {

        if (messageType==="interactive") {

            if(pattern2.test(message?.interactive?.list_reply?.id))
{
    const orderResponse = await axios.post(
        `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
        {
            messaging_product: "whatsapp",
            to: sender,
            text: {
                body: `We got your request and opdated your order status...\nPlease message "Hello" or "Hi" to start new conversation`
            }
        },
        {
            headers: { "Content-Type": "application/json" }
        }
         );
}
            if(!orderPattern.test(message?.interactive?.list_reply?.title)){
                const fallbackResponse = await axios.post(
                    `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
                    {
                        messaging_product: "whatsapp",
                        recipient_type: "individual",
                        to: sender,
                        type: "interactive",
                        interactive: {
                            type: "list",
                            header: {
                                type: "text",
                                text: message?.interactive?.list_reply?.title
                            },
                            body: {
                                text: `Here are the list of order that are ${message?.interactive?.list_reply?.title} click below to get more about the order.`
                            },
                            action: {
                                button: "View Orders",
                                sections: [
                                    {
                                        title: message?.interactive?.list_reply?.title,
                                        rows: [
                                            {
                                                id: "orderID",
                                                title: "SRVZ-ORD-738762",
                                                description: "Order Assigned"
                                            },
                                            {
                                                id: "orderID1",
                                                title: "SRVZ-ORD-738800",
                                                description: "Order Assigned"
                                            },
                                            {
                                                id: "orderID2",
                                                title: "SRVZ-ORD-738800",
                                                description: "Order Assigned"
                                            },
                                        ]
                                    }
                                ]
                            }
                        }
                    },
                    {
                        headers: {
                            "Content-Type": "application/json"
                        }
                    }
                );
                
        
                console.log("✅ Fallback message sent:", fallbackResponse.data);
                res.sendStatus(200);
            }

           if(orderPattern.test(message?.interactive?.list_reply?.title)){
             // 🔹 Handle order ID messages
            const fallbackResponse = await axios.post(
                `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
                {
                    messaging_product: "whatsapp",
                    recipient_type: "individual",
                    to: "918826095638",
                    type: "interactive",
                    interactive: {
                        type: "list",
                        header: {
                            type: "text",
                            text: `Order ID: ${message?.interactive?.list_reply?.title}`
                        },
                        body: {
                            text: `📦 Order Details\n\n🆔 Current Status: Technician Assigned\nSchedule time: 12 July 2023, 12:22\n\nAppliance Details\nCategory: Air Conditionar\nSubcategory: Split AC\nIssue: Not cooling\n\nCustomer Detais\nName:Vikas Kumar\nAddress: Delhi\nContact number: 8826095638`
                        },
                        footer: {
                            text: "Click to more option to Accept, Reject or Change Status"
    },
                        action: {
                            button: "More Options",
                            sections: [
                                {
                                    title: "Your Options",
                                    rows: [
                                        {
                                            id: "accept1",
                                            title: "Accept Order",
                                            description: "You can start your work."
                                        },
                                        {
                                            id: "accept2",
                                            title: "Reject Order",
                                            description: "You have no longer access to this order."
                                        }
                                    ]
                                }
                            ]
                        }
                    }
                },
                {
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );

            console.log("✅ Order message sent:", fallbackResponse.data);
            return res.sendStatus(200);
           }

           const orderResponse = await axios.post(
            `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
            {
                messaging_product: "whatsapp",
                to: sender,
                text: {
                    body: `It seems your option is invalid`
                }
            },
            {
                headers: { "Content-Type": "application/json" }
            }
             );

        console.log("✅ Order message sent:", orderResponse.data);
        return res.sendStatus(200);
    
        }

        // 🔹 Fallback message for any other input
        const fallbackResponse = await axios.post(
            `https://graph.facebook.com/v22.0/${phoneNumberId}/messages?access_token=${token}`,
            {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: "918826095638",
                type: "interactive",
                interactive: {
                    type: "list",
                    header: {
                        type: "text",
                        text: `Hi ${sender}, welcome to SERVIZ Technician BOT.`
                    },
                    body: {
                        text: "Please select an option to continue"
                    },
                    action: {
                        button: "Get Orders by Status",
                        sections: [
                            {
                                title: "Your Options",
                                rows: [
                                    {
                                        id: "pendingOrders",
                                        title: "Pending Orders",
                                        description: "Orders not started yet."
                                    },
                                    {
                                        id: "wipOrders",
                                        title: "WIP Orders",
                                        description: "Orders started and pending."
                                    },
                                    {
                                        id: "completedOrders",
                                        title: "Completed Orders",
                                        description: "Orders that are completed recently."
                                    }
                                ]
                            }
                        ]
                    }
                }
            },
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
        

        console.log("✅ Fallback message sent:", fallbackResponse.data);
        res.sendStatus(200);
    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error.message);
        res.sendStatus(500);
    }
});


// Default route
app.get("/", (req, res) => {
    res.status(200).send("Hello, this is the WhatsApp webhook setup!");
});
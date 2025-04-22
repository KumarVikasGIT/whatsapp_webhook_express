const exprss = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
require("dotenv").config();

const app = exprss().use(body_parser.json());

let token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

app.listen(8033, () => {
  console.log("webhook is listning");
});

// to verify the callback url form dashboard site - cloud api
app.get("/webhook", (req, res) => {
  let mode = req.query["hub.mode"];
  let challenge = req.query["hub.challenge"];
  let verify_token = req.query["hub.verify_token"];

  if (mode && verify_token) {
    if (mode === "subscribe" && verify_token === mytoken) {
      res.status(200).send(challenge);
    } else {
      res.status(403);
    }
  }
});

app.post("/webhook", (req, res) => {
  let body_param = req.body;
  console.log(JSON.stringify(body_param, null, 2));

  if (body_param.entry && body_param.entry[0].changes) {
    let phone_no_id =
      body_param.entry[0].changes[0].value.metadate.phone_no_id;
    let from = body_param.entry[0].changes[0].value.messages[0].form;

    axios({
      method: "POST",
      url: "https://graph.facebook.com/v22.0/" + phone_no_id + "/messages?access_token" +token,
      data: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: from,
        type: "text",
        text: {
          preview_url: true,
          body: "Hi this is Vikas here",
        },
      },
      headers:{
        "Content-Type":"application/json"
      }
    });

    res.sendStatus(200);
  }
  else{
    res.sendStatus(403);
  }
});
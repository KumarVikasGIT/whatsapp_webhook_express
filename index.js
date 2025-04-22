const exprss=require("express");
const body_parser=require("body-parser");

const app=exprss().use(body_parser.json());

app.listen(8033,()=>{
  console.log("webhook is listning");
});

// to verify the callback url form dashboard site - cloud api
app.get("/webhook", (req,res)=>{
  let mode=req.query["hub.mode"];
  let challenge=req.query["hub.challenge"];
  let verify_token= req.query["hub.verify_token"];

  const mytoken= "testVikas";

  if(mode && verify_token){

    if(mode==="subscribe" && verify_token===mytoken){
      res.status(200).send(challenge);
    }
    else{
      res.status(403);
    }
  }
});
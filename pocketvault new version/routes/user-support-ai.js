import express from 'express';
import { db, FieldValue } from '../core/firebase.js';
import { requireAuth, asyncHandler } from '../core/middleware.js';
import { answerUserSupport } from '../core/system-ai.js';

const router=express.Router();
router.post('/api/support/threads/:threadId/ai-reply',requireAuth,asyncHandler(async(req,res)=>{
  const uid=req.user.uid;
  const ref=db.collection('support_threads').doc(req.params.threadId);
  const snap=await ref.get();
  if(!snap.exists)return res.status(404).json({success:false,error:'Support thread not found.'});
  const thread={id:snap.id,...snap.data()};
  if(thread.uid!==uid)return res.status(403).json({success:false,error:'You can only use AI support on your own conversation.'});
  if(thread.status==='resolved')return res.status(400).json({success:false,error:'This conversation is resolved.'});
  const userSnap=await db.collection('users').doc(uid).get();
  const user=userSnap.data()||{};
  const text=await answerUserSupport({user,thread});
  if(!text)return res.status(502).json({success:false,error:'PocketVault AI could not produce a response. A support agent can still review your message.'});
  const message={from:'ai',text,createdAt:new Date().toISOString(),timestamp:FieldValue.serverTimestamp(),ai:true};
  await ref.update({messages:FieldValue.arrayUnion(message),lastMessageAt:FieldValue.serverTimestamp(),lastMessageFrom:'ai',aiAssisted:true});
  res.json({success:true,message:text,from:'ai'});
}));
export default router;

const express = require("express");
const cors = require("cors");
require("dotenv").config();
const axios = require("axios");
const port = process.env.PORT || 3000;
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require('http');
const { Server } = require('socket.io');
const FormData = require('form-data');
const fs = require('fs');
const fetch = require('node-fetch');

// Create HTTP server and Socket.IO instance
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:8081", "http://localhost:19006", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }
});

// Middleware
app.use(
  cors({
    origin: ["http://localhost:8081", "http://localhost:19006", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(
  express.json({
    limit: "50mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  express.urlencoded({
    extended: true,
    limit: "50mb",
  })
);
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.5iz2xl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Store active users and their socket connections
const activeUsers = new Map(); // userId -> socketId
const userSockets = new Map(); // socketId -> userId
const activeCalls = new Map(); // callId -> call data

let usersCollection, postsCollection, storiesCollection, friendsCollection, notificationsCollection, conversationsCollection, messagesCollection, videosCollection;

// Notification Types
const NOTIFICATION_TYPES = {
  POST_LIKE: 'post_like',
  POST_COMMENT: 'post_comment',
  COMMENT_REPLY: 'comment_reply',
  POST_SHARE: 'post_share',
  FRIEND_REQUEST: 'friend_request',
  FRIEND_REQUEST_ACCEPTED: 'friend_request_accepted',
  MENTION: 'mention',
  TAG: 'tag',
  INCOMING_CALL: 'incoming_call',
  MISSED_CALL: 'missed_call',
  NEW_VIDEO: 'new_video'
};

// Streamable Configuration
const STREAMABLE_CONFIG = {
  email: process.env.STREAMABLE_EMAIL,
  password: process.env.STREAMABLE_PASSWORD,
  baseUrl: 'https://api.streamable.com'
};

// Enhanced Create a notification (utility function) with WebSocket support
async function createNotification(notificationData) {
  try {
    const notification = {
      ...notificationData,
      isRead: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    const result = await notificationsCollection.insertOne(notification);
    const insertedId = result.insertedId;

    // Get the complete notification with populated data
    const completeNotification = await notificationsCollection.aggregate([
      { $match: { _id: insertedId } },
      {
        $lookup: {
          from: "users",
          localField: "senderId",
          foreignField: "_id",
          as: "sender",
        },
      },
      { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          "sender.password": 0,
          "sender.email": 0,
        },
      },
    ]).next();

    // Emit real-time notification via WebSocket to the recipient
    const recipientId = notificationData.recipientId.toString();
    
    // Check if recipient is online
    const isRecipientOnline = activeUsers.has(recipientId);
    
    if (isRecipientOnline) {
      io.to(recipientId).emit('new_notification', {
        notification: completeNotification
      });

      // Also update unread count in real-time
      const unreadCount = await notificationsCollection.countDocuments({
        recipientId: new ObjectId(recipientId),
        isRead: false,
      });

      io.to(recipientId).emit('unread_count_updated', {
        unreadCount
      });
    }

    // Also emit to specific notifications room
    io.to(`notifications_${recipientId}`).emit('notification_created', {
      notification: completeNotification
    });

    console.log(`Notification sent to user ${recipientId}, online: ${isRecipientOnline}`);
    
    return insertedId;
  } catch (error) {
    console.error("Error creating notification:", error);
    return null;
  }
}

// Enhanced createNotification function for post interactions
async function createPostInteractionNotification(interactionData) {
  const {
    type,
    postId,
    commentId,
    replyId,
    senderId,
    recipientId,
    content,
    metadata = {}
  } = interactionData;

  // Don't create notification if user is interacting with their own content
  if (senderId.toString() === recipientId.toString()) {
    return null;
  }

  let message = '';
  let notificationType = type;

  switch (type) {
    case NOTIFICATION_TYPES.POST_LIKE:
      message = 'liked your post';
      break;
    case NOTIFICATION_TYPES.POST_COMMENT:
      message = 'commented on your post';
      break;
    case NOTIFICATION_TYPES.COMMENT_REPLY:
      message = 'replied to your comment';
      break;
    case NOTIFICATION_TYPES.POST_SHARE:
      message = 'shared your post';
      break;
    default:
      message = 'interacted with your content';
  }

  const notificationData = {
    type: notificationType,
    senderId: new ObjectId(senderId),
    recipientId: new ObjectId(recipientId),
    message,
    metadata: {
      postId: new ObjectId(postId),
      ...metadata
    },
    isRead: false,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  // Add comment/reply IDs if applicable
  if (commentId) {
    notificationData.metadata.commentId = new ObjectId(commentId);
  }
  if (replyId) {
    notificationData.metadata.replyId = new ObjectId(replyId);
  }

  // Add content preview (truncated)
  if (content) {
    notificationData.metadata.contentPreview = content.length > 100 
      ? content.substring(0, 100) + '...' 
      : content;
  }

  return await createNotification(notificationData);
}

// Helper function to get user info
async function getUserInfo(userId) {
  try {
    const user = await usersCollection.findOne(
      { _id: new ObjectId(userId) },
      { projection: { name: 1, profilePicture: 1, username: 1, email: 1 } }
    );
    return user;
  } catch (error) {
    console.error('Error getting user info:', error);
    return null;
  }
}

// Helper function to create call record in database
async function createCallRecord(callData) {
  try {
    const callRecord = {
      callId: callData.callId,
      callerId: new ObjectId(callData.callerId),
      recipientId: new ObjectId(callData.recipientId),
      callType: callData.callType,
      conversationId: callData.conversationId ? new ObjectId(callData.conversationId) : null,
      status: callData.status,
      participants: callData.participants.map(id => new ObjectId(id)),
      startedAt: callData.createdAt,
      endedAt: null,
      duration: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    return callRecord;
  } catch (error) {
    console.error('Error creating call record:', error);
    return null;
  }
}

// Helper function to update call record
async function updateCallRecord(callId, updateData) {
  try {
    console.log(`Call ${callId} updated:`, updateData);
  } catch (error) {
    console.error('Error updating call record:', error);
  }
}

// Streamable Video Upload Functions
async function uploadToStreamable(videoBuffer, filename, title = '') {
  try {
    const formData = new FormData();
    formData.append('file', videoBuffer, {
      filename: filename,
      contentType: 'video/mp4'
    });
    
    if (title) {
      formData.append('title', title);
    }

    const auth = Buffer.from(`${STREAMABLE_CONFIG.email}:${STREAMABLE_CONFIG.password}`).toString('base64');

    const response = await fetch(`${STREAMABLE_CONFIG.baseUrl}/upload`, {
      method: 'POST',
      body: formData,
      headers: {
        'Authorization': `Basic ${auth}`,
        ...formData.getHeaders()
      }
    });

    if (!response.ok) {
      throw new Error(`Streamable API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    
    if (result.shortcode) {
      return {
        success: true,
        shortcode: result.shortcode,
        url: `https://streamable.com/${result.shortcode}`,
        status: result.status,
        message: 'Video uploaded successfully to Streamable'
      };
    } else {
      throw new Error(result.message || 'Upload failed');
    }
  } catch (error) {
    console.error('Error uploading to Streamable:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

async function getStreamableVideoStatus(shortcode) {
  try {
    const auth = Buffer.from(`${STREAMABLE_CONFIG.email}:${STREAMABLE_CONFIG.password}`).toString('base64');
    
    const response = await fetch(`${STREAMABLE_CONFIG.baseUrl}/videos/${shortcode}`, {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });

    if (!response.ok) {
      throw new Error(`Streamable API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return {
      success: true,
      data: result
    };
  } catch (error) {
    console.error('Error getting Streamable video status:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Socket.IO authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  
  if (!token) {
    return next(new Error("Authentication error: No token provided"));
  }

  jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
    if (err) {
      return next(new Error("Authentication error: Invalid token"));
    }
    socket.userId = decoded.userId;
    next();
  });
});

// Initialize WebSocket handlers after database connection
function initializeWebSocketHandlers() {
  io.on('connection', (socket) => {
    console.log('User connected:', socket.userId, 'Socket ID:', socket.id);

    // Store user connection
    activeUsers.set(socket.userId, socket.id);
    userSockets.set(socket.id, socket.userId);

    // Join user to their personal room for notifications
    socket.join(socket.userId);
    socket.join(`notifications_${socket.userId}`); // Specific notifications room

    // Join all user's conversation rooms
    const joinUserConversations = async () => {
      try {
        const conversations = await conversationsCollection.find({
          participants: new ObjectId(socket.userId)
        }).toArray();

        conversations.forEach(conversation => {
          socket.join(conversation._id.toString());
          console.log(`User ${socket.userId} joined conversation ${conversation._id}`);
        });
      } catch (error) {
        console.error('Error joining conversations:', error);
      }
    };

    joinUserConversations();

    // Notify that user is online
    socket.broadcast.emit('user_status_change', {
      userId: socket.userId,
      isOnline: true,
      lastSeen: new Date()
    });

    // **WEBRTC CALL HANDLERS**

    // Initiate a call
    socket.on('call_initiate', async (data) => {
      try {
        const { recipientId, callType, conversationId } = data;
        
        console.log(`Call initiated: ${callType} from ${socket.userId} to ${recipientId}`);
        
        // Check if recipient is online
        const recipientSocketId = activeUsers.get(recipientId);
        
        if (recipientSocketId) {
          // Create call data
          const callId = `call_${Date.now()}_${socket.userId}`;
          const callData = {
            callId: callId,
            callerId: socket.userId,
            recipientId: recipientId,
            callType: callType, // 'audio' or 'video'
            conversationId: conversationId,
            status: 'ringing',
            createdAt: new Date(),
            participants: [socket.userId]
          };
          
          // Store call data
          activeCalls.set(callId, callData);
          
          // Create call record in database
          await createCallRecord(callData);
          
          // Get caller info
          const callerInfo = await getUserInfo(socket.userId);
          
          // Emit to recipient
          io.to(recipientId).emit('incoming_call', {
            ...callData,
            callerInfo: callerInfo
          });
          
          // Confirm to caller that call was initiated
          socket.emit('call_initiated', {
            callId: callId,
            recipientOnline: true
          });
          
          console.log(`Incoming call sent to ${recipientId}`);
          
          // Create missed call notification if call isn't answered
          const missedCallTimeout = setTimeout(async () => {
            const currentCall = activeCalls.get(callId);
            if (currentCall && currentCall.status === 'ringing') {
              console.log(`Call ${callId} timed out`);
              
              // Create missed call notification
              await createNotification({
                type: NOTIFICATION_TYPES.MISSED_CALL,
                senderId: new ObjectId(socket.userId),
                recipientId: new ObjectId(recipientId),
                message: 'missed your call',
                metadata: {
                  callId: callId,
                  callType: callType,
                  conversationId: conversationId
                }
              });
              
              // Notify both parties
              io.to(socket.userId).emit('call_rejected', {
                callId: callId,
                recipientId: recipientId,
                reason: 'Call timed out'
              });
              
              io.to(recipientId).emit('call_ended', {
                callId: callId,
                endedBy: 'system',
                reason: 'Call timed out'
              });
              
              // Update call record
              await updateCallRecord(callId, {
                status: 'missed',
                endedAt: new Date(),
                updatedAt: new Date()
              });
              
              // Remove from active calls
              activeCalls.delete(callId);
            }
          }, 45000); // 45 seconds timeout
          
          // Store timeout reference in call data
          callData.missedCallTimeout = missedCallTimeout;
          activeCalls.set(callId, callData);
          
        } else {
          // Recipient is offline
          socket.emit('call_failed', {
            reason: 'recipient_offline',
            message: 'User is currently offline'
          });
          
          // Create missed call notification
          await createNotification({
            type: NOTIFICATION_TYPES.MISSED_CALL,
            senderId: new ObjectId(socket.userId),
            recipientId: new ObjectId(recipientId),
            message: 'called you',
            metadata: {
              callId: `missed_${Date.now()}`,
              callType: callType,
              conversationId: conversationId
            }
          });
        }
      } catch (error) {
        console.error('Error initiating call:', error);
        socket.emit('call_failed', {
          reason: 'server_error',
          message: 'Failed to initiate call'
        });
      }
    });

    // Accept a call
    socket.on('call_accept', async (data) => {
      try {
        const { callId } = data;
        
        console.log(`Call ${callId} accepted by ${socket.userId}`);
        
        const callData = activeCalls.get(callId);
        if (!callData) {
          socket.emit('call_error', {
            message: 'Call not found'
          });
          return;
        }
        
        // Clear the missed call timeout
        if (callData.missedCallTimeout) {
          clearTimeout(callData.missedCallTimeout);
        }
        
        // Update call status
        callData.status = 'active';
        callData.answeredAt = new Date();
        callData.participants.push(socket.userId);
        activeCalls.set(callId, callData);
        
        // Update call record
        await updateCallRecord(callId, {
          status: 'active',
          answeredAt: new Date(),
          updatedAt: new Date()
        });
        
        // Get recipient info
        const recipientInfo = await getUserInfo(socket.userId);
        
        // Notify the caller that call was accepted
        io.to(callData.callerId).emit('call_accepted', {
          callId: callId,
          recipientId: socket.userId,
          recipientInfo: recipientInfo
        });
        
        console.log(`Call ${callId} accepted successfully`);
        
      } catch (error) {
        console.error('Error accepting call:', error);
        socket.emit('call_error', {
          message: 'Failed to accept call'
        });
      }
    });

    // Reject a call
    socket.on('call_reject', async (data) => {
      const { callId, reason } = data;
      
      console.log(`Call ${callId} rejected by ${socket.userId}, reason: ${reason}`);
      
      const callData = activeCalls.get(callId);
      if (!callData) return;
      
      // Clear the missed call timeout
      if (callData.missedCallTimeout) {
        clearTimeout(callData.missedCallTimeout);
      }
      
      // Update call record
      await updateCallRecord(callId, {
        status: 'rejected',
        endedAt: new Date(),
        reason: reason,
        updatedAt: new Date()
      });
      
      // Notify the caller
      io.to(callData.callerId).emit('call_rejected', {
        callId: callId,
        recipientId: socket.userId,
        reason: reason || 'Call rejected'
      });
      
      // Remove from active calls
      activeCalls.delete(callId);
    });

    // End a call
    socket.on('call_end', async (data) => {
      const { callId, reason } = data;
      
      console.log(`Call ${callId} ended by ${socket.userId}`);
      
      const callData = activeCalls.get(callId);
      if (!callData) return;
      
      // Calculate call duration
      const duration = callData.answeredAt ? 
        Date.now() - callData.answeredAt.getTime() : 0;
      
      // Update call record
      await updateCallRecord(callId, {
        status: 'ended',
        endedAt: new Date(),
        duration: duration,
        reason: reason,
        updatedAt: new Date()
      });
      
      // Notify all participants
      callData.participants.forEach(participantId => {
        io.to(participantId).emit('call_ended', {
          callId: callId,
          endedBy: socket.userId,
          reason: reason || 'Call ended',
          duration: duration
        });
      });
      
      // Remove from active calls
      activeCalls.delete(callId);
    });

    // WebRTC signaling: offer
    socket.on('webrtc_offer', (data) => {
      const { callId, offer, recipientId } = data;
      
      console.log(`WebRTC offer for call ${callId}`);
      
      const callData = activeCalls.get(callId);
      if (!callData) {
        socket.emit('call_error', { message: 'Call not found' });
        return;
      }
      
      // Forward the offer to the recipient
      io.to(recipientId).emit('webrtc_offer', {
        callId: callId,
        offer: offer,
        callerId: socket.userId
      });
    });

    // WebRTC signaling: answer
    socket.on('webrtc_answer', (data) => {
      const { callId, answer, recipientId } = data;
      
      console.log(`WebRTC answer for call ${callId}`);
      
      const callData = activeCalls.get(callId);
      if (!callData) {
        socket.emit('call_error', { message: 'Call not found' });
        return;
      }
      
      // Forward the answer to the recipient
      io.to(recipientId).emit('webrtc_answer', {
        callId: callId,
        answer: answer,
        answererId: socket.userId
      });
    });

    // WebRTC signaling: ice candidate
    socket.on('webrtc_ice_candidate', (data) => {
      const { callId, candidate, recipientId } = data;
      
      const callData = activeCalls.get(callId);
      if (!callData) {
        socket.emit('call_error', { message: 'Call not found' });
        return;
      }
      
      // Forward the ICE candidate to the recipient
      io.to(recipientId).emit('webrtc_ice_candidate', {
        callId: callId,
        candidate: candidate,
        senderId: socket.userId
      });
    });

    // Get active call info
    socket.on('get_call_info', (data) => {
      const { callId } = data;
      const callData = activeCalls.get(callId);
      
      socket.emit('call_info', {
        callId: callId,
        callData: callData
      });
    });

    // Check if user is in a call
    socket.on('check_active_call', () => {
      let userActiveCall = null;
      activeCalls.forEach((callData, callId) => {
        if (callData.participants.includes(socket.userId)) {
          userActiveCall = { callId, ...callData };
        }
      });
      
      socket.emit('active_call_status', {
        hasActiveCall: !!userActiveCall,
        callData: userActiveCall
      });
    });

    // **NOTIFICATION WEB SOCKET EVENTS**

    // Mark notification as read via WebSocket
    socket.on('mark_notification_read', async (data) => {
      try {
        const { notificationId } = data;
        
        const result = await notificationsCollection.updateOne(
          {
            _id: new ObjectId(notificationId),
            recipientId: new ObjectId(socket.userId),
          },
          { $set: { isRead: true, readAt: new Date() } }
        );

        if (result.modifiedCount > 0) {
          // Notify the user that notification was marked as read
          socket.emit('notification_marked_read', {
            notificationId,
            success: true
          });

          // Update unread count for all user's devices
          const unreadCount = await notificationsCollection.countDocuments({
            recipientId: new ObjectId(socket.userId),
            isRead: false,
          });

          io.to(socket.userId).emit('unread_count_updated', {
            unreadCount
          });
        }
      } catch (error) {
        console.error('Error marking notification as read via WebSocket:', error);
        socket.emit('notification_error', {
          error: 'Failed to mark notification as read'
        });
      }
    });

    // Post interaction WebSocket events
    socket.on('post_liked', async (data) => {
      try {
        const { postId, userId } = data;
        
        // Notify post owner in real-time
        const post = await postsCollection.findOne(
          { _id: new ObjectId(postId) },
          { projection: { userId: 1 } }
        );

        if (post && post.userId.toString() !== userId) {
          socket.to(post.userId.toString()).emit('post_like_notification', {
            postId,
            likedBy: userId,
            timestamp: new Date()
          });
        }
      } catch (error) {
        console.error('Error handling post_liked event:', error);
      }
    });

    socket.on('comment_added', async (data) => {
      try {
        const { postId, commentId, userId } = data;
        
        // Notify post owner or comment owner in real-time
        const post = await postsCollection.findOne(
          { _id: new ObjectId(postId) },
          { projection: { userId: 1, comments: 1 } }
        );

        if (post) {
          const comment = post.comments.find(c => c._id.toString() === commentId);
          if (comment) {
            const recipientId = comment.parentCommentId 
              ? (await getParentCommentAuthor(postId, comment.parentCommentId))
              : post.userId.toString();

            if (recipientId && recipientId !== userId) {
              socket.to(recipientId).emit('comment_notification', {
                postId,
                commentId,
                commentedBy: userId,
                isReply: !!comment.parentCommentId,
                timestamp: new Date()
              });
            }
          }
        }
      } catch (error) {
        console.error('Error handling comment_added event:', error);
      }
    });

    // Helper function to get parent comment author
    async function getParentCommentAuthor(postId, parentCommentId) {
      try {
        const post = await postsCollection.findOne(
          { 
            _id: new ObjectId(postId),
            "comments._id": new ObjectId(parentCommentId)
          },
          { projection: { "comments.$": 1 } }
        );
        
        return post && post.comments.length > 0 
          ? post.comments[0].userId.toString() 
          : null;
      } catch (error) {
        console.error('Error getting parent comment author:', error);
        return null;
      }
    }

    // Mark all notifications as read via WebSocket
    socket.on('mark_all_notifications_read', async () => {
      try {
        const result = await notificationsCollection.updateMany(
          {
            recipientId: new ObjectId(socket.userId),
            isRead: false,
          },
          { $set: { isRead: true, readAt: new Date() } }
        );

        socket.emit('all_notifications_marked_read', {
          success: true,
          markedCount: result.modifiedCount
        });

        // Update unread count
        io.to(socket.userId).emit('unread_count_updated', {
          unreadCount: 0
        });

      } catch (error) {
        console.error('Error marking all notifications as read via WebSocket:', error);
        socket.emit('notification_error', {
          error: 'Failed to mark all notifications as read'
        });
      }
    });

    // Subscribe to real-time notifications
    socket.on('subscribe_notifications', () => {
      console.log(`User ${socket.userId} subscribed to real-time notifications`);
      // User is already joined to their notification room
    });

    // Unsubscribe from notifications (optional)
    socket.on('unsubscribe_notifications', () => {
      socket.leave(`notifications_${socket.userId}`);
    });

    // Request current unread count
    socket.on('get_unread_count', async () => {
      try {
        const unreadCount = await notificationsCollection.countDocuments({
          recipientId: new ObjectId(socket.userId),
          isRead: false,
        });

        socket.emit('unread_count', {
          unreadCount
        });
      } catch (error) {
        console.error('Error getting unread count via WebSocket:', error);
      }
    });

    // Delete notification via WebSocket
    socket.on('delete_notification', async (data) => {
      try {
        const { notificationId } = data;
        
        const result = await notificationsCollection.deleteOne({
          _id: new ObjectId(notificationId),
          recipientId: new ObjectId(socket.userId),
        });

        if (result.deletedCount > 0) {
          socket.emit('notification_deleted', {
            notificationId,
            success: true
          });

          // Update unread count
          const unreadCount = await notificationsCollection.countDocuments({
            recipientId: new ObjectId(socket.userId),
            isRead: false,
          });

          io.to(socket.userId).emit('unread_count_updated', {
            unreadCount
          });
        }
      } catch (error) {
        console.error('Error deleting notification via WebSocket:', error);
        socket.emit('notification_error', {
          error: 'Failed to delete notification'
        });
      }
    });

    // Handle typing events
    socket.on('typing_start', (data) => {
      const { conversationId } = data;
      socket.to(conversationId).emit('user_typing', {
        userId: socket.userId,
        conversationId,
        isTyping: true
      });
    });

    socket.on('typing_stop', (data) => {
      const { conversationId } = data;
      socket.to(conversationId).emit('user_typing', {
        userId: socket.userId,
        conversationId,
        isTyping: false
      });
    });

    // Handle message read events
    socket.on('mark_messages_read', async (data) => {
      try {
        const { conversationId } = data;
        
        // Mark all messages in conversation as read by this user
        await messagesCollection.updateMany(
          {
            conversationId: new ObjectId(conversationId),
            senderId: { $ne: new ObjectId(socket.userId) },
            readBy: { $ne: new ObjectId(socket.userId) }
          },
          {
            $push: { readBy: new ObjectId(socket.userId) }
          }
        );

        // Reset unread count for this user
        await conversationsCollection.updateOne(
          {
            _id: new ObjectId(conversationId),
            "unreadCounts.userId": new ObjectId(socket.userId)
          },
          {
            $set: { "unreadCounts.$.count": 0 }
          }
        );

        // Notify other participants that messages were read
        socket.to(conversationId).emit('messages_read', {
          conversationId,
          readBy: socket.userId,
          readAt: new Date()
        });

      } catch (error) {
        console.error('Error marking messages as read:', error);
      }
    });

    // Handle disconnect
    socket.on('disconnect', async () => {
      console.log('User disconnected:', socket.userId);
      
      // End all active calls for this user
      activeCalls.forEach(async (callData, callId) => {
        if (callData.participants.includes(socket.userId)) {
          // Calculate call duration
          const duration = callData.answeredAt ? 
            Date.now() - callData.answeredAt.getTime() : 0;
          
          // Update call record
          await updateCallRecord(callId, {
            status: 'ended',
            endedAt: new Date(),
            duration: duration,
            reason: 'User disconnected',
            updatedAt: new Date()
          });
          
          // Notify other participants
          callData.participants.forEach(participantId => {
            if (participantId !== socket.userId) {
              io.to(participantId).emit('call_ended', {
                callId: callId,
                endedBy: 'system',
                reason: 'User disconnected',
                duration: duration
              });
            }
          });
          
          // Remove from active calls
          activeCalls.delete(callId);
        }
      });
      
      activeUsers.delete(socket.userId);
      userSockets.delete(socket.id);

      // Notify others that user went offline
      socket.broadcast.emit('user_status_change', {
        userId: socket.userId,
        isOnline: false,
        lastSeen: new Date()
      });
    });
  });
}

// Utility function to get unread counts
async function getUnreadCounts(conversationId) {
  const conversation = await conversationsCollection.findOne(
    { _id: new ObjectId(conversationId) },
    { projection: { unreadCounts: 1 } }
  );
  return conversation?.unreadCounts || [];
}

// Utility function to emit to specific user
function emitToUser(userId, event, data) {
  const socketId = activeUsers.get(userId);
  if (socketId) {
    io.to(socketId).emit(event, data);
  }
}

async function run() {
  try {
    await client.connect();

    const database = client.db("social_media");
    usersCollection = database.collection("users");
    postsCollection = database.collection("posts");
    storiesCollection = database.collection("stories");
    friendsCollection = database.collection("friends");
    notificationsCollection = database.collection("notifications");
    conversationsCollection = database.collection("conversations");
    messagesCollection = database.collection("messages");
    videosCollection = database.collection("videos"); // For storing video metadata
    
    console.log("Database collections initialized successfully");

    // Initialize WebSocket handlers after collections are ready
    initializeWebSocketHandlers();

    // **STREAMABLE VIDEO UPLOAD ENDPOINTS**

    // Upload video to Streamable
    app.post("/upload/video", VerifyToken, async (req, res) => {
      try {
        const { video, title, description } = req.body;
        const userId = req.user.userId;

        if (!video) {
          return res.status(400).send({
            success: false,
            message: "No video data provided",
          });
        }

        console.log("Processing video upload to Streamable...");

        // Validate video data
        if (!video.startsWith("data:video/")) {
          return res.status(400).send({
            success: false,
            message: "Invalid video format. Expected base64 video data.",
          });
        }

        // Extract base64 data and metadata
        const videoMatch = video.match(/^data:video\/(\w+);base64,(.+)$/);
        if (!videoMatch) {
          return res.status(400).send({
            success: false,
            message: "Invalid video base64 format",
          });
        }

        const videoFormat = videoMatch[1]; // mp4, mov, etc.
        const base64Data = videoMatch[2];
        
        // Convert base64 to buffer
        const videoBuffer = Buffer.from(base64Data, 'base64');
        
        // Calculate video size
        const videoSizeInBytes = videoBuffer.length;

        // Validate video size (max 250MB for Streamable free tier)
        if (videoSizeInBytes > 250 * 1024 * 1024) {
          return res.status(413).send({
            success: false,
            message: "Video too large. Maximum size is 250MB for Streamable.",
          });
        }

        console.log(`Video details - Format: ${videoFormat}, Size: ${(videoSizeInBytes / 1024 / 1024).toFixed(2)}MB`);

        // Generate filename
        const filename = `video-${Date.now()}.${videoFormat}`;
        const videoTitle = title || `Video by user ${userId}`;

        // Upload to Streamable
        const uploadResult = await uploadToStreamable(videoBuffer, filename, videoTitle);

        if (!uploadResult.success) {
          throw new Error(uploadResult.error || 'Failed to upload to Streamable');
        }

        // Store video metadata in database
        const videoMetadata = {
          userId: new ObjectId(userId),
          streamableShortcode: uploadResult.shortcode,
          streamableUrl: uploadResult.url,
          title: videoTitle,
          description: description || "",
          format: videoFormat,
          size: videoSizeInBytes,
          status: 'uploaded',
          privacy: "public",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await videosCollection.insertOne(videoMetadata);

        // Create notification for followers about new video
        const followers = await friendsCollection.find({
          $or: [
            { requesterId: new ObjectId(userId), status: "accepted" },
            { recipientId: new ObjectId(userId), status: "accepted" },
          ],
        }).toArray();

        const followerIds = followers.map(f => 
          f.requesterId.toString() === userId ? f.recipientId : f.requesterId
        );

        // Create notifications for followers
        for (const followerId of followerIds) {
          await createNotification({
            type: NOTIFICATION_TYPES.NEW_VIDEO,
            senderId: new ObjectId(userId),
            recipientId: followerId,
            message: "uploaded a new video",
            metadata: {
              videoId: result.insertedId,
              streamableShortcode: uploadResult.shortcode,
              streamableUrl: uploadResult.url,
            }
          });
        }

        res.status(200).send({
          success: true,
          message: "Video uploaded successfully to Streamable",
          video: {
            id: result.insertedId,
            shortcode: uploadResult.shortcode,
            url: uploadResult.url,
            title: videoTitle,
            size: videoSizeInBytes,
            format: videoFormat,
            status: uploadResult.status
          },
        });
      } catch (error) {
        console.error("Error uploading video to Streamable:", error);
        res.status(500).send({
          success: false,
          message: "Server error during video upload",
          error: error.message,
        });
      }
    });

    // Upload video from URL to Streamable
    app.post("/upload/video/url", VerifyToken, async (req, res) => {
      try {
        const { videoUrl, title, description } = req.body;
        const userId = req.user.userId;

        if (!videoUrl) {
          return res.status(400).send({
            success: false,
            message: "No video URL provided",
          });
        }

        console.log("Importing video from URL to Streamable:", videoUrl);

        const formData = new FormData();
        formData.append('url', videoUrl);
        
        if (title) {
          formData.append('title', title);
        }

        const auth = Buffer.from(`${STREAMABLE_CONFIG.email}:${STREAMABLE_CONFIG.password}`).toString('base64');

        const response = await fetch(`${STREAMABLE_CONFIG.baseUrl}/import`, {
          method: 'POST',
          body: formData,
          headers: {
            'Authorization': `Basic ${auth}`,
            ...formData.getHeaders()
          }
        });

        if (!response.ok) {
          throw new Error(`Streamable API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();

        if (result.shortcode) {
          // Store video metadata in database
          const videoMetadata = {
            userId: new ObjectId(userId),
            streamableShortcode: result.shortcode,
            streamableUrl: `https://streamable.com/${result.shortcode}`,
            title: title || `Video by user ${userId}`,
            description: description || "",
            sourceUrl: videoUrl,
            status: 'importing',
            privacy: "public",
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const dbResult = await videosCollection.insertOne(videoMetadata);

          res.status(200).send({
            success: true,
            message: "Video import started successfully",
            video: {
              id: dbResult.insertedId,
              shortcode: result.shortcode,
              url: `https://streamable.com/${result.shortcode}`,
              title: title,
              status: result.status
            },
          });
        } else {
          throw new Error(result.message || 'Import failed');
        }
      } catch (error) {
        console.error("Error importing video to Streamable:", error);
        res.status(500).send({
          success: false,
          message: "Server error during video import",
          error: error.message,
        });
      }
    });

    // Get Streamable video status
    app.get("/video/:shortcode/status", VerifyToken, async (req, res) => {
      try {
        const { shortcode } = req.params;

        const statusResult = await getStreamableVideoStatus(shortcode);

        if (!statusResult.success) {
          return res.status(404).send({
            success: false,
            message: "Video not found or error fetching status",
            error: statusResult.error
          });
        }

        res.send({
          success: true,
          video: statusResult.data
        });
      } catch (error) {
        console.error("Error getting video status:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Get user's uploaded videos
    app.get("/videos/my", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { page = 1, limit = 10 } = req.query;
        const skip = (page - 1) * parseInt(limit);

        const videos = await videosCollection
          .find({ userId: new ObjectId(userId) })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await videosCollection.countDocuments({ 
          userId: new ObjectId(userId) 
        });

        res.send({
          success: true,
          videos,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total
          }
        });
      } catch (error) {
        console.error("Error fetching user videos:", error);
        res.status(500).send({
          success: false,
          message: "Server error while fetching videos",
          error: error.message,
        });
      }
    });

    // Get all public videos
    app.get("/videos", VerifyToken, async (req, res) => {
      try {
        const { page = 1, limit = 10 } = req.query;
        const skip = (page - 1) * parseInt(limit);

        const videos = await videosCollection
          .aggregate([
            { $match: { privacy: "public" } },
            {
              $lookup: {
                from: "users",
                localField: "userId",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
            {
              $project: {
                "user.password": 0,
                "user.email": 0,
              },
            },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) },
          ])
          .toArray();

        const total = await videosCollection.countDocuments({ 
          privacy: "public" 
        });

        res.send({
          success: true,
          videos,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total
          }
        });
      } catch (error) {
        console.error("Error fetching videos:", error);
        res.status(500).send({
          success: false,
          message: "Server error while fetching videos",
          error: error.message,
        });
      }
    });

    // Delete video from Streamable
    app.delete("/video/:shortcode", VerifyToken, async (req, res) => {
      try {
        const { shortcode } = req.params;
        const userId = req.user.userId;

        // First, check if video exists and belongs to user
        const video = await videosCollection.findOne({ 
          streamableShortcode: shortcode,
          userId: new ObjectId(userId)
        });

        if (!video) {
          return res.status(404).send({
            success: false,
            message: "Video not found or unauthorized"
          });
        }

        const auth = Buffer.from(`${STREAMABLE_CONFIG.email}:${STREAMABLE_CONFIG.password}`).toString('base64');

        const response = await fetch(`${STREAMABLE_CONFIG.baseUrl}/videos/${shortcode}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Basic ${auth}`
          }
        });

        if (response.status === 204) {
          // Also delete from database
          await videosCollection.deleteOne({ 
            streamableShortcode: shortcode,
            userId: new ObjectId(userId)
          });

          res.send({
            success: true,
            message: "Video deleted successfully from Streamable"
          });
        } else {
          throw new Error('Failed to delete video from Streamable');
        }
      } catch (error) {
        console.error("Error deleting video:", error);
        res.status(500).send({
          success: false,
          message: "Server error while deleting video",
          error: error.message,
        });
      }
    });

app.get("/video/:shortcode/embed", VerifyToken, async (req, res) => {
      try {
        const { shortcode } = req.params;

        const statusResult = await getStreamableVideoStatus(shortcode);

        if (!statusResult.success) {
          return res.status(404).send({
            success: false,
            message: "Video not found"
          });
        }

        const videoData = statusResult.data;

        res.send({
          success: true,
          embed: {
            shortcode: shortcode,
            url: `https://streamable.com/${shortcode}`,
            embedUrl: `https://streamable.com/e/${shortcode}`,
            thumbnail: videoData.thumbnail_url,
            title: videoData.title,
            duration: videoData.duration,
            files: videoData.files
          }
        });
      } catch (error) {
        console.error("Error getting video embed info:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });


    app.put("/video/:shortcode/privacy", VerifyToken, async (req, res) => {
      try {
        const { shortcode } = req.params;
        const userId = req.user.userId;
        const { privacy } = req.body;

        if (!privacy || !['public', 'private'].includes(privacy)) {
          return res.status(400).send({
            success: false,
            message: "Invalid privacy setting. Use 'public' or 'private'"
          });
        }

        const video = await videosCollection.findOne({ 
          streamableShortcode: shortcode,
          userId: new ObjectId(userId)
        });

        if (!video) {
          return res.status(404).send({
            success: false,
            message: "Video not found or unauthorized"
          });
        }

        await videosCollection.updateOne(
          { streamableShortcode: shortcode },
          { $set: { privacy, updatedAt: new Date() } }
        );

        res.send({
          success: true,
          message: `Video privacy updated to ${privacy}`
        });
      } catch (error) {
        console.error("Error updating video privacy:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Health check for Streamable
    app.get("/streamable/health", VerifyToken, async (req, res) => {
      try {
        // Test Streamable connection by getting account info
        const auth = Buffer.from(`${STREAMABLE_CONFIG.email}:${STREAMABLE_CONFIG.password}`).toString('base64');
        
        const response = await fetch(`${STREAMABLE_CONFIG.baseUrl}/user`, {
          headers: {
            'Authorization': `Basic ${auth}`
          }
        });

        if (response.ok) {
          const userData = await response.json();
          res.send({
            success: true,
            message: "Streamable connection successful",
            account: {
              username: userData.username,
              plan: userData.plan,
              uploadsRemaining: userData.uploads_remaining
            }
          });
        } else {
          throw new Error('Streamable connection failed');
        }
      } catch (error) {
        console.error("Streamable health check failed:", error);
        res.status(500).send({
          success: false,
          message: "Streamable connection failed",
          error: error.message,
        });
      }
    });

    // Enhanced Notification APIs
    app.get("/notifications", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { 
          page = 1, 
          limit = 20, 
          unreadOnly = false,
          type 
        } = req.query;
        
        const skip = (page - 1) * parseInt(limit);

        // Build query
        const query = { recipientId: new ObjectId(userId) };
        
        if (unreadOnly === "true") {
          query.isRead = false;
        }
        
        if (type && type !== 'all') {
          query.type = type;
        }

        const notifications = await notificationsCollection
          .aggregate([
            { $match: query },
            {
              $lookup: {
                from: "users",
                localField: "senderId",
                foreignField: "_id",
                as: "sender",
              },
            },
            { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                "sender.password": 0,
                "sender.email": 0,
              },
            },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) },
          ])
          .toArray();

        // Get unread count for each type
        const unreadCounts = await notificationsCollection.aggregate([
          {
            $match: {
              recipientId: new ObjectId(userId),
              isRead: false
            }
          },
          {
            $group: {
              _id: "$type",
              count: { $sum: 1 }
            }
          }
        ]).toArray();

        const totalUnread = await notificationsCollection.countDocuments({
          recipientId: new ObjectId(userId),
          isRead: false,
        });

        res.send({
          success: true,
          notifications,
          unreadCount: totalUnread,
          unreadCounts: unreadCounts.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {}),
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: await notificationsCollection.countDocuments({
              recipientId: new ObjectId(userId),
            }),
          },
          realTimeEnabled: true,
          websocketEvents: [
            'new_notification',
            'notification_marked_read',
            'all_notifications_marked_read',
            'unread_count_updated',
            'notification_deleted'
          ]
        });
      } catch (error) {
        console.error("Error fetching notifications:", error);
        res.status(500).send({
          success: false,
          message: "Server error while fetching notifications",
          error: error.message,
        });
      }
    });

    // Get notification statistics with real-time updates
    app.get("/notifications/stats", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const stats = await notificationsCollection.aggregate([
          {
            $match: {
              recipientId: new ObjectId(userId)
            }
          },
          {
            $group: {
              _id: "$type",
              total: { $sum: 1 },
              unread: {
                $sum: {
                  $cond: [{ $eq: ["$isRead", false] }, 1, 0]
                }
              }
            }
          }
        ]).toArray();

        const totalUnread = await notificationsCollection.countDocuments({
          recipientId: new ObjectId(userId),
          isRead: false,
        });

        res.send({
          success: true,
          stats: stats.reduce((acc, item) => {
            acc[item._id] = item;
            return acc;
          }, {}),
          totalUnread
        });
      } catch (error) {
        console.error("Error fetching notification stats:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Get notifications with real-time capabilities
    app.get("/notifications/real-time", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { limit = 20 } = req.query;

        const notifications = await notificationsCollection
          .aggregate([
            { $match: { recipientId: new ObjectId(userId) } },
            {
              $lookup: {
                from: "users",
                localField: "senderId",
                foreignField: "_id",
                as: "sender",
              },
            },
            { $unwind: { path: "$sender", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                "sender.password": 0,
                "sender.email": 0,
              },
            },
            { $sort: { createdAt: -1 } },
            { $limit: parseInt(limit) },
          ])
          .toArray();

        const unreadCount = await notificationsCollection.countDocuments({
          recipientId: new ObjectId(userId),
          isRead: false,
        });

        res.send({
          success: true,
          notifications,
          unreadCount,
          realTimeEnabled: true,
          websocketEvents: [
            'new_notification',
            'notification_marked_read',
            'all_notifications_marked_read',
            'unread_count_updated',
            'notification_deleted'
          ]
        });
      } catch (error) {
        console.error("Error fetching real-time notifications:", error);
        res.status(500).send({
          success: false,
          message: "Server error while fetching notifications",
          error: error.message,
        });
      }
    });

    // Mark notification as read
    app.put("/notifications/:id/read", VerifyToken, async (req, res) => {
      try {
        const notificationId = req.params.id;
        const userId = req.user.userId;

        const result = await notificationsCollection.updateOne(
          {
            _id: new ObjectId(notificationId),
            recipientId: new ObjectId(userId),
          },
          { $set: { isRead: true, readAt: new Date() } }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Notification not found or unauthorized",
          });
        }

        // Emit WebSocket event for real-time update
        const unreadCount = await notificationsCollection.countDocuments({
          recipientId: new ObjectId(userId),
          isRead: false,
        });

        io.to(userId).emit('unread_count_updated', {
          unreadCount
        });

        res.send({
          success: true,
          message: "Notification marked as read",
        });
      } catch (error) {
        console.error("Error marking notification as read:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Mark all notifications as read
    app.put("/notifications/read-all", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const result = await notificationsCollection.updateMany(
          {
            recipientId: new ObjectId(userId),
            isRead: false,
          },
          { $set: { isRead: true, readAt: new Date() } }
        );

        // Emit WebSocket event for real-time update
        io.to(userId).emit('unread_count_updated', {
          unreadCount: 0
        });

        res.send({
          success: true,
          message: `Marked ${result.modifiedCount} notifications as read`,
          markedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Error marking all notifications as read:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Delete a notification
    app.delete("/notifications/:id", VerifyToken, async (req, res) => {
      try {
        const notificationId = req.params.id;
        const userId = req.user.userId;

        const result = await notificationsCollection.deleteOne({
          _id: new ObjectId(notificationId),
          recipientId: new ObjectId(userId),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Notification not found or unauthorized",
          });
        }

        // Update unread count via WebSocket
        const unreadCount = await notificationsCollection.countDocuments({
          recipientId: new ObjectId(userId),
          isRead: false,
        });

        io.to(userId).emit('unread_count_updated', {
          unreadCount
        });

        res.send({
          success: true,
          message: "Notification deleted successfully",
        });
      } catch (error) {
        console.error("Error deleting notification:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Clear all notifications
    app.delete("/notifications", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const result = await notificationsCollection.deleteMany({
          recipientId: new ObjectId(userId),
        });

        // Emit WebSocket event for real-time update
        io.to(userId).emit('unread_count_updated', {
          unreadCount: 0
        });

        res.send({
          success: true,
          message: `Cleared ${result.deletedCount} notifications`,
          deletedCount: result.deletedCount,
        });
      } catch (error) {
        console.error("Error clearing notifications:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Get unread notifications count
    app.get("/notifications/unread-count", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const unreadCount = await notificationsCollection.countDocuments({
          recipientId: new ObjectId(userId),
          isRead: false,
        });

        res.send({
          success: true,
          unreadCount,
        });
      } catch (error) {
        console.error("Error fetching unread count:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Real-time notification subscription endpoint
    app.post("/notifications/subscribe", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        
        res.send({
          success: true,
          message: "Use WebSocket connection for real-time notifications. Events: new_notification, unread_count_updated"
        });
      } catch (error) {
        console.error("Error in notification subscription:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Create a test notification (for development)
    app.post("/notifications/test", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { type = "test", message = "Test notification" } = req.body;

        const notificationId = await createNotification({
          type,
          senderId: new ObjectId(userId),
          recipientId: new ObjectId(userId),
          message,
          isRead: false
        });

        res.send({
          success: true,
          message: "Test notification created",
          notificationId
        });
      } catch (error) {
        console.error("Error creating test notification:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Call History APIs
    app.get("/calls/history", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { page = 1, limit = 20 } = req.query;
        const skip = (page - 1) * parseInt(limit);

        // For now, return empty array since we don't have calls collection
        const calls = [];
        const total = 0;

        res.send({
          success: true,
          calls,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total
          }
        });
      } catch (error) {
        console.error("Error fetching call history:", error);
        res.status(500).send({
          success: false,
          message: "Server error while fetching call history",
          error: error.message,
        });
      }
    });

    // Get active calls for user
    app.get("/calls/active", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const userActiveCalls = [];

        activeCalls.forEach((callData, callId) => {
          if (callData.participants.includes(userId)) {
            userActiveCalls.push({ callId, ...callData });
          }
        });

        res.send({
          success: true,
          activeCalls: userActiveCalls
        });
      } catch (error) {
        console.error("Error fetching active calls:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Get online users
    app.get("/users/online", VerifyToken, async (req, res) => {
      try {
        const onlineUsers = [];
        
        activeUsers.forEach((socketId, userId) => {
          onlineUsers.push(userId);
        });

        res.send({
          success: true,
          onlineUsers,
          count: onlineUsers.length
        });
      } catch (error) {
        console.error("Error fetching online users:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    // JWT posting
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN, {
        expiresIn: "72h",
      });
      res.cookie("token", token).send({ success: true, token });
    });

    function VerifyToken(req, res, next) {
      const authHeader = req.headers.authorization;  

      if (!authHeader) {
        console.log("No authorization header found");
        return res
          .status(401)
          .send({ message: "Access Denied - No Token Found" });
      }

      const token = authHeader.split(" ")[1];
      if (!token) {
        return res
          .status(401)
          .send({ message: "Access Denied - Invalid Token Format" });
      }

      jwt.verify(token, process.env.ACCESS_TOKEN, (err, user) => {
        if (err) {
          console.log("JWT verification error:", err.message);
          return res.status(403).send({ message: "Invalid Token" });
        }
        req.user = user;
        next();
      });
    }

    app.get("/status", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const isOnline = activeUsers.has(userId);
        
        let userActiveCall = null;
        activeCalls.forEach((callData, callId) => {
          if (callData.participants.includes(userId)) {
            userActiveCall = { callId, ...callData };
          }
        });

        res.send({
          success: true,
          user: {
            id: userId,
            isOnline: isOnline,
            hasActiveCall: !!userActiveCall
          },
          server: {
            activeCalls: activeCalls.size,
            onlineUsers: activeUsers.size,
            uptime: process.uptime()
          }
        });
      } catch (error) {
        console.error("Error getting server status:", error);
        res.status(500).send({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    app.post("/upload", VerifyToken, async (req, res) => {
      try {
        const { image } = req.body;

        if (!image) {
          return res.status(400).send({
            success: false,
            message: "No image data provided",
          });
        }

        console.log("Received image upload request");

        // Validate that it's a base64 image
        if (!image.startsWith("data:image/")) {
          return res.status(400).send({
            success: false,
            message: "Invalid image format. Expected base64 image data.",
          });
        }

        // Extract base64 data
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");

        // Validate image size
        const imageSizeInBytes = (base64Data.length * 3) / 4;
        if (imageSizeInBytes > 10 * 1024 * 1024) {
          return res.status(413).send({
            success: false,
            message: "Image too large. Maximum size is 10MB.",
          });
        }

        console.log("Uploading image to imgBB...");

        // Upload to imgBB
        const formData = new URLSearchParams();
        formData.append("image", base64Data);

        const imgBBResponse = await axios.post(
          `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
          formData,
          {
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 30000,
          }
        );

        if (imgBBResponse.data.success) {
          const imageUrl = imgBBResponse.data.data.url;

          res.status(200).send({
            success: true,
            message: "Image uploaded successfully",
            url: imageUrl,
            imgBBData: imgBBResponse.data.data,
          });
        } else {
          throw new Error(
            imgBBResponse.data.error?.message || "Image upload failed"
          );
        }
      } catch (error) {
        console.error("Error uploading image to imgBB:", error);

        if (error.code === "ECONNABORTED") {
          return res.status(408).send({
            success: false,
            message: "Image upload timeout. Please try again.",
          });
        }

        if (error.response) {
          res.status(error.response.status).send({
            success: false,
            message: "Image upload service error",
            error: error.response.data.error?.message || "Upload failed",
          });
        } else {
          res.status(500).send({
            success: false,
            message: "Server error during image upload",
            error: error.message,
          });
        }
      }
    });

    app.post("/logout", VerifyToken, (req, res) => {
      res.clearCookie("token");
      res.send({ message: "Logged out Successfully" });
    });

    // User Authentication APIs
    app.post("/signup", async (req, res) => {
      try {
        const { name,username, email, password  } = req.body;

        // Check if user already exists
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
          return res.status(400).send({ message: "User already exists" });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Create user with default profile
        const newUser = {
          name,
          username,
          email,
          password: hashedPassword,
          profilePicture: "",
          bio: "",
          isProfileComplete: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await usersCollection.insertOne(newUser);

        // Generate token
        const token = jwt.sign(
          { userId: result.insertedId, email },
          process.env.ACCESS_TOKEN,
          { expiresIn: "72h" }
        );

        res.status(201).send({
          success: true,
          message: "User created successfully. Please complete your profile.",
          token,
          user: {
            id: result.insertedId,
            name,
            email,
            profilePicture: "",
            bio: "",
            isProfileComplete: false,
          },
          requiresProfileCompletion: true,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.post("/signin", async (req, res) => {
      try {
        const { email, password } = req.body;

        // Find user
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(400).send({ message: "Invalid credentials" });
        }

        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
          return res.status(400).send({ message: "Invalid credentials" });
        }

        // Generate token
        const token = jwt.sign(
          { userId: user._id, email: user.email },
          process.env.ACCESS_TOKEN,
          { expiresIn: "72h" }
        );

        // Check if profile needs completion
        const requiresProfileCompletion = !user.profilePicture && !user.bio;

        res.cookie("token", token).send({
          success: true,
          token,
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            profilePicture: user.profilePicture || "",
            bio: user.bio || "",
            isProfileComplete: !requiresProfileCompletion,
          },
          requiresProfileCompletion: requiresProfileCompletion,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Update user profile
    app.put("/profile", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { profilePicture, bio, name, coverPhoto } = req.body;

        const updateData = {
          updatedAt: new Date(),
        };

        // Only update fields that are provided
        if (profilePicture !== undefined)
          updateData.profilePicture = profilePicture;
        if (bio !== undefined) updateData.bio = bio;
        if (name !== undefined) updateData.name = name;
        if (coverPhoto !== undefined) updateData.coverPhoto = coverPhoto;

        // Check if profile is complete (has both profile picture and bio)
        const currentUser = await usersCollection.findOne({
          _id: new ObjectId(userId),
        });
        const hasProfilePicture =
          profilePicture !== undefined
            ? profilePicture
            : currentUser.profilePicture;
        const hasBio = bio !== undefined ? bio : currentUser.bio;

        updateData.isProfileComplete = !!(hasProfilePicture && hasBio);

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(userId) },
          { $set: updateData }
        );

        if (result.modifiedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        // Get updated user data
        const updatedUser = await usersCollection.findOne(
          { _id: new ObjectId(userId) },
          { projection: { password: 0 } }
        );

        res.send({
          success: true,
          message: "Profile updated successfully",
          user: updatedUser,
          isProfileComplete: updateData.isProfileComplete,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get user profile
    app.get("/profile", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const user = await usersCollection.findOne(
          { _id: new ObjectId(userId) },
          { projection: { password: 0 } }
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        // Get user's posts count
        const postsCount = await postsCollection.countDocuments({
          userId: new ObjectId(userId),
        });

        // Get friends count
        const friendsCount = await friendsCollection.countDocuments({
          $or: [
            { requesterId: new ObjectId(userId), status: "accepted" },
            { recipientId: new ObjectId(userId), status: "accepted" },
          ],
        });

        res.send({
          success: true,
          user: {
            ...user,
            postsCount,
            friendsCount,
          },
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get other user's profile (public)
    app.get("/users/:userId", VerifyToken, async (req, res) => {
      try {
        const userId = req.params.userId;

        const user = await usersCollection.findOne(
          { _id: new ObjectId(userId) },
          {
            projection: {
              password: 0,
              email: 0,
            },
          }
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        // Get user's posts count
        const postsCount = await postsCollection.countDocuments({
          userId: new ObjectId(userId),
        });

        // Get friends count
        const friendsCount = await friendsCollection.countDocuments({
          $or: [
            { requesterId: new ObjectId(userId), status: "accepted" },
            { recipientId: new ObjectId(userId), status: "accepted" },
          ],
        });

        // Check if current user is friends with this user
        const isFriend = await friendsCollection.findOne({
          $or: [
            {
              requesterId: new ObjectId(req.user.userId),
              recipientId: new ObjectId(userId),
              status: "accepted",
            },
            {
              requesterId: new ObjectId(userId),
              recipientId: new ObjectId(req.user.userId),
              status: "accepted",
            },
          ],
        });

        res.send({
          success: true,
          user: {
            ...user,
            postsCount,
            friendsCount,
            isFriend: !!isFriend,
          },
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Post APIs
    app.post("/posts", VerifyToken, async (req, res) => {
  try {
    const { content, image, privacy, location } = req.body;
    const userId = req.user.userId;

    if (!content && !image) {
      return res.status(400).send({
        success: false,
        message: "Post must contain either content or image",
      });
    }

    let imageUrl = "";
    let imageData = null;

    // Upload base64 image to imgBB
    if (image && image.startsWith("data:image/")) {
      try {
        console.log("Uploading base64 image to imgBB...");

        const base64Data = image.split(",")[1];

        const formData = new FormData();
        formData.append("image", base64Data);

        const imgRes = await axios.post(
          `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
          formData,
          { headers: formData.getHeaders(), timeout: 30000 }
        );

        if (imgRes.data.success) {
          const d = imgRes.data.data;
          imageUrl = d.url;

          imageData = {
            url: d.url,
            deleteUrl: d.delete_url,
            imageId: d.id,
            size: d.size,
            type: d.image.mime,
            filename: d.image.filename,
          };

          console.log("Uploaded:", imageUrl);
        }
      } catch (err) {
        console.error("Image upload failed:", err.message);
      }
    }

    // If image is already a URL
    else if (image) {
      imageUrl = image;
    }

    const newPost = {
      userId: new ObjectId(userId),
      content: content || "",
      image: imageUrl,
      imageData: imageData,
      location,
      privacy,
      likes: [],
      comments: [],
      shares: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await postsCollection.insertOne(newPost);

    const post = await postsCollection
      .aggregate([
        { $match: { _id: result.insertedId } },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            "user.password": 0,
            "user.email": 0,
          },
        },
      ])
      .toArray();

    res.status(201).send({
      success: true,
      message: "Post created",
      post: post[0],
    });
  } catch (error) {
    console.error("Post error:", error);

    res.status(500).send({
      success: false,
      message: "Server error while creating post",
      error: error.message,
    });
  }
});


    // Health check endpoint
    app.get("/health", (req, res) => {
      res.status(200).json({
        success: true,
        message: "Server is running with WebSocket support",
        timestamp: new Date().toISOString(),
        websocket: true,
        database: "connected",
        streamable: STREAMABLE_CONFIG.email ? "configured" : "not configured"
      });
    });

    // Get posts with image support
    app.get("/posts", VerifyToken, async (req, res) => {
      try {
        const { page = 1, limit = 10, userId } = req.query;
        const currentUserId = req.user.userId;
        const skip = (page - 1) * parseInt(limit);

        // Get current user's friends list
        const currentUser = await usersCollection.findOne(
          { _id: new ObjectId(currentUserId) },
          { projection: { friends: 1 } }
        );

        const friendsIds = currentUser?.friends || [];
        
        // Build privacy filter query
        const privacyMatchQuery = {
          $or: [
            { privacy: "public" },
            { 
              privacy: "friends", 
              userId: { $in: [new ObjectId(currentUserId), ...friendsIds.map(id => new ObjectId(id))] }
            },
            { userId: new ObjectId(currentUserId) }
          ]
        };

        // Add user filter if specified
        const finalMatchQuery = userId 
          ? { 
              $and: [
                { userId: new ObjectId(userId) },
                privacyMatchQuery
              ]
            }
          : privacyMatchQuery;

        const posts = await postsCollection
          .aggregate([
            { $match: finalMatchQuery },
            {
              $lookup: {
                from: "users",
                localField: "userId",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
            {
              $project: {
                "user.password": 0,
                "user.email": 0,
              },
            },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) },
          ])
          .toArray();

        res.send({
          success: true,
          posts,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: await postsCollection.countDocuments(finalMatchQuery),
          },
        });
      } catch (error) {
        console.error("Error fetching posts:", error);
        res.status(500).send({ 
          success: false,
          message: "Server error", 
          error: error.message 
        });
      }
    });

    // Update post with image support
    app.put("/posts/:id", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const { content, image, privacy } = req.body;
        const userId = req.user.userId;

        // Check if post exists and user owns it
        const post = await postsCollection.findOne({
          _id: new ObjectId(postId),
          userId: new ObjectId(userId),
        });

        if (!post) {
          return res
            .status(404)
            .send({ message: "Post not found or unauthorized" });
        }

        let imageUrl = post.image;
        let imageData = post.imageData;

        // Handle image update
        if (image && image !== post.image) {
          if (image.startsWith("data:image/")) {
            // New base64 image - upload it
            try {
              const uploadResponse = await axios.post(
                `http://localhost:${port}/upload`,
                { image },
                {
                  headers: {
                    Authorization: req.headers.authorization,
                    "Content-Type": "application/json",
                  },
                }
              );

              if (uploadResponse.data.success) {
                imageUrl = uploadResponse.data.url;
                imageData = {
                  url: uploadResponse.data.url,
                  thumbUrl: uploadResponse.data.thumbUrl,
                  mediumUrl: uploadResponse.data.mediumUrl,
                  deleteUrl: uploadResponse.data.deleteUrl,
                  imageId: uploadResponse.data.imageId,
                };
              }
            } catch (uploadError) {
              console.error("Failed to upload new image:", uploadError);
              // Keep old image if upload fails
            }
          } else {
            // It's already a URL
            imageUrl = image;
            imageData = null;
          }
        }

        const updateData = {
          content: content !== undefined ? content : post.content,
          image: imageUrl,
          imageData: imageData,
          privacy: privacy || post.privacy,
          updatedAt: new Date(),
        };

        await postsCollection.updateOne(
          { _id: new ObjectId(postId) },
          { $set: updateData }
        );

        res.send({
          success: true,
          message: "Post updated successfully",
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/posts/:id", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;

        const post = await postsCollection
          .aggregate([
            { $match: { _id: new ObjectId(postId) } },
            {
              $lookup: {
                from: "users",
                localField: "userId",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
            {
              $project: {
                "user.password": 0,
              },
            },
          ])
          .toArray();

        if (!post.length) {
          return res.status(404).send({ message: "Post not found" });
        }

        res.send({
          success: true,
          post: post[0],
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.delete("/posts/:id", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const userId = req.user.userId;

        // Check if post exists and user owns it
        const post = await postsCollection.findOne({
          _id: new ObjectId(postId),
          userId: new ObjectId(userId),
        });

        if (!post) {
          return res
            .status(404)
            .send({ message: "Post not found or unauthorized" });
        }

        await postsCollection.deleteOne({ _id: new ObjectId(postId) });

        res.send({
          success: true,
          message: "Post deleted successfully",
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Enhanced Like/Unlike Post with Notification
    app.post("/posts/:id/like", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const userId = req.user.userId;

        const post = await postsCollection.findOne({
          _id: new ObjectId(postId),
        });
        
        if (!post) {
          return res.status(404).send({ message: "Post not found" });
        }

        const hasLiked = post.likes.some(
          (like) => like.userId.toString() === userId
        );

        if (hasLiked) {
          // Unlike
          await postsCollection.updateOne(
            { _id: new ObjectId(postId) },
            { $pull: { likes: { userId: new ObjectId(userId) } } }
          );
          
          res.send({ success: true, message: "Post unliked", liked: false });
        } else {
          // Like with notification
          await postsCollection.updateOne(
            { _id: new ObjectId(postId) },
            {
              $push: {
                likes: {
                  userId: new ObjectId(userId),
                  likedAt: new Date(),
                },
              },
            }
          );

          // Create notification for post owner (unless it's their own post)
          if (post.userId.toString() !== userId) {
            await createPostInteractionNotification({
              type: NOTIFICATION_TYPES.POST_LIKE,
              postId: postId,
              senderId: userId,
              recipientId: post.userId,
              content: '', // No content for likes
              metadata: {
                likeId: new ObjectId() // Generate a new ID for the like
              }
            });
          }

          res.send({ success: true, message: "Post liked", liked: true });
        }
      } catch (error) {
        console.error("Error in like endpoint:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Enhanced Comment on Post with Notification
    app.post("/posts/:id/comment", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const userId = req.user.userId;
        const { content, parentCommentId } = req.body; // Add parentCommentId for replies

        if (!content) {
          return res.status(400).send({ message: "Comment content is required" });
        }

        const comment = {
          _id: new ObjectId(),
          userId: new ObjectId(userId),
          content,
          parentCommentId: parentCommentId ? new ObjectId(parentCommentId) : null,
          replies: [],
          likes: [],
          createdAt: new Date(),
          updatedAt: new Date()
        };

        await postsCollection.updateOne(
          { _id: new ObjectId(postId) },
          { $push: { comments: comment } }
        );

        // Get user details for the comment
        const user = await usersCollection.findOne(
          { _id: new ObjectId(userId) },
          { projection: { name: 1, profilePicture: 1 } }
        );

        // Get post details for notification
        const post = await postsCollection.findOne(
          { _id: new ObjectId(postId) },
          { projection: { userId: 1, content: 1 } }
        );

        let notificationType = NOTIFICATION_TYPES.POST_COMMENT;
        let recipientId = post.userId;
        let metadata = { commentId: comment._id };

        // If this is a reply to a comment, notify the comment author
        if (parentCommentId) {
          // Find the parent comment to get its author
          const postWithComment = await postsCollection.findOne(
            { 
              _id: new ObjectId(postId),
              "comments._id": new ObjectId(parentCommentId)
            },
            { projection: { "comments.$": 1 } }
          );
          
          if (postWithComment && postWithComment.comments.length > 0) {
            const parentComment = postWithComment.comments[0];
            notificationType = NOTIFICATION_TYPES.COMMENT_REPLY;
            recipientId = parentComment.userId;
            metadata.parentCommentId = new ObjectId(parentCommentId);
          }
        }

        // Create notification (unless commenting on own post/comment)
        if (recipientId.toString() !== userId) {
          await createPostInteractionNotification({
            type: notificationType,
            postId: postId,
            commentId: comment._id,
            senderId: userId,
            recipientId: recipientId,
            content: content,
            metadata: metadata
          });
        }

        res.send({
          success: true,
          message: parentCommentId ? "Reply added successfully" : "Comment added successfully",
          comment: {
            ...comment,
            user: {
              name: user.name,
              profilePicture: user.profilePicture,
            },
            isReply: !!parentCommentId
          },
        });
      } catch (error) {
        console.error("Error in comment endpoint:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });
// Update user interests
app.post("/user/interests", VerifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { interests } = req.body;

    console.log('🎯 Interests endpoint called');
    console.log('📤 User ID:', userId);
    console.log('📦 Received interests:', interests);

    if (!interests || !Array.isArray(interests)) {
      console.log('❌ Invalid interests data');
      return res.status(400).send({
        success: false,
        message: "Interests array is required",
      });
    }

    // Validate interests
    if (interests.length < 3) {
      console.log('❌ Not enough interests:', interests.length);
      return res.status(400).send({
        success: false,
        message: "Please select at least 3 interests",
      });
    }

    console.log('✅ Valid interests received, updating database...');

    // Update user interests
    const result = await usersCollection.updateOne(
      { _id: new ObjectId(userId) },
      { 
        $set: { 
          interests: interests,
          hasCompletedInterests: true,
          updatedAt: new Date()
        } 
      }
    );

    console.log('📊 Database update result:', result);

    if (result.modifiedCount === 0) {
      console.log('❌ User not found in database');
      return res.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    // Get updated user data
    const updatedUser = await usersCollection.findOne(
      { _id: new ObjectId(userId) },
      { projection: { password: 0 } }
    );

    console.log('✅ Interests updated successfully');
    console.log('👤 Updated user:', updatedUser);

    res.send({
      success: true,
      message: "Interests updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("❌ Error updating interests:", error);
    res.status(500).send({
      success: false,
      message: "Server error while updating interests",
      error: error.message,
    });
  }
});
// Get user interests (optional - if you need to fetch them)
app.get("/user/interests", VerifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const user = await usersCollection.findOne(
      { _id: new ObjectId(userId) },
      { projection: { interests: 1, hasCompletedInterests: 1 } }
    );

    if (!user) {
      return res.status(404).send({
        success: false,
        message: "User not found",
      });
    }

    res.send({
      success: true,
      interests: user.interests || [],
      hasCompletedInterests: user.hasCompletedInterests || false,
    });
  } catch (error) {
    console.error("Error fetching interests:", error);
    res.status(500).send({
      success: false,
      message: "Server error while fetching interests",
      error: error.message,
    });
  }
});
    // Enhanced Share Post with Notification
    app.post("/posts/:id/share", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const userId = req.user.userId;
        const { sharedContent } = req.body;

        // Get original post
        const originalPost = await postsCollection.findOne({
          _id: new ObjectId(postId),
        });

        if (!originalPost) {
          return res.status(404).send({ message: "Original post not found" });
        }

        // Increment share count on original post
        await postsCollection.updateOne(
          { _id: new ObjectId(postId) },
          { $inc: { shares: 1 } }
        );

        // Create a new shared post
        const sharedPost = {
          userId: new ObjectId(userId),
          content: sharedContent || `Shared: ${originalPost.content.substring(0, 100)}...`,
          originalPostId: new ObjectId(postId),
          isShared: true,
          likes: [],
          comments: [],
          shares: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await postsCollection.insertOne(sharedPost);

        // Create notification for original post owner (unless sharing own post)
        if (originalPost.userId.toString() !== userId) {
          await createPostInteractionNotification({
            type: NOTIFICATION_TYPES.POST_SHARE,
            postId: postId,
            senderId: userId,
            recipientId: originalPost.userId,
            content: sharedContent || '',
            metadata: {
              sharedPostId: result.insertedId,
              originalPostId: new ObjectId(postId)
            }
          });
        }

        res.send({
          success: true,
          message: "Post shared successfully",
          sharedPostId: result.insertedId
        });
      } catch (error) {
        console.error("Error in share endpoint:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Like/Unlike Comment
    app.post("/posts/:postId/comments/:commentId/like", VerifyToken, async (req, res) => {
      try {
        const { postId, commentId } = req.params;
        const userId = req.user.userId;

        const post = await postsCollection.findOne({
          _id: new ObjectId(postId),
          "comments._id": new ObjectId(commentId)
        });

        if (!post) {
          return res.status(404).send({ message: "Post or comment not found" });
        }

        const comment = post.comments.find(c => c._id.toString() === commentId);
        const hasLiked = comment.likes.some(like => like.userId.toString() === userId);

        if (hasLiked) {
          // Unlike comment
          await postsCollection.updateOne(
            { 
              _id: new ObjectId(postId),
              "comments._id": new ObjectId(commentId)
            },
            { 
              $pull: { 
                "comments.$.likes": { userId: new ObjectId(userId) } 
              } 
            }
          );
          
          res.send({ success: true, message: "Comment unliked", liked: false });
        } else {
          // Like comment
          await postsCollection.updateOne(
            { 
              _id: new ObjectId(postId),
              "comments._id": new ObjectId(commentId)
            },
            { 
              $push: { 
                "comments.$.likes": { 
                  userId: new ObjectId(userId),
                  likedAt: new Date()
                } 
              } 
            }
          );

          // Create notification for comment owner (unless it's their own comment)
          if (comment.userId.toString() !== userId) {
            await createPostInteractionNotification({
              type: NOTIFICATION_TYPES.POST_LIKE, // Or create COMMENT_LIKE type if needed
              postId: postId,
              commentId: new ObjectId(commentId),
              senderId: userId,
              recipientId: comment.userId,
              content: comment.content,
              metadata: {
                interaction: 'comment_like'
              }
            });
          }

          res.send({ success: true, message: "Comment liked", liked: true });
        }
      } catch (error) {
        console.error("Error in comment like endpoint:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get comment replies
    app.get("/posts/:postId/comments/:commentId/replies", VerifyToken, async (req, res) => {
      try {
        const { postId, commentId } = req.params;

        const post = await postsCollection.findOne(
          { 
            _id: new ObjectId(postId),
            "comments._id": new ObjectId(commentId)
          },
          { 
            projection: { 
              "comments.$": 1 
            } 
          }
        );

        if (!post || !post.comments.length) {
          return res.status(404).send({ message: "Comment not found" });
        }

        const comment = post.comments[0];
        
        // Get user details for replies
        const repliesWithUsers = await Promise.all(
          (comment.replies || []).map(async (reply) => {
            const user = await usersCollection.findOne(
              { _id: reply.userId },
              { projection: { name: 1, profilePicture: 1 } }
            );
            return {
              ...reply,
              user: {
                name: user.name,
                profilePicture: user.profilePicture
              }
            };
          })
        );

        res.send({
          success: true,
          replies: repliesWithUsers
        });
      } catch (error) {
        console.error("Error fetching comment replies:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/users/search/:name", VerifyToken, async (req, res) => {
      try {
        const { name } = req.params;

        if (!name) {
          return res.status(400).json({
            success: false,
            message: "Search parameter is required",
          });
        }

        console.log("Searching for:", name);

        const users = await usersCollection
          .find(
            {
              $or: [
                { name: { $regex: name, $options: "i" } },
                { email: { $regex: name, $options: "i" } },
                { username: { $regex: name, $options: "i" } },
              ],
            },
            {
              projection: { password: 0 },
            }
          )
          .toArray();

        res.json({
          success: true,
          users: users || [],
        });
      } catch (error) {
        console.error("Search error:", error);
        res.status(500).json({
          success: false,
          message: "Server error",
          error: error.message,
        });
      }
    });

    app.post("/friends/:friendId", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const friendId = req.params.friendId;

        if (userId === friendId) {
          return res
            .status(400)
            .send({ message: "Cannot add yourself as friend" });
        }

        // Check if friend request already exists
        const existingRequest = await friendsCollection.findOne({
          $or: [
            {
              requesterId: new ObjectId(userId),
              recipientId: new ObjectId(friendId),
            },
            {
              requesterId: new ObjectId(friendId),
              recipientId: new ObjectId(userId),
            },
          ],
        });

        if (existingRequest) {
          return res
            .status(400)
            .send({ message: "Friend request already exists" });
        }

        // Create friend request
        const friendRequest = {
          requesterId: new ObjectId(userId),
          recipientId: new ObjectId(friendId),
          status: "pending",
          createdAt: new Date(),
        };

        await friendsCollection.insertOne(friendRequest);

        // Create notification for the recipient
        await createNotification({
          type: "friend_request",
          senderId: new ObjectId(userId),
          recipientId: new ObjectId(friendId),
          message: "sent you a friend request",
          metadata: {
            requestId: friendRequest._id
          }
        });

        res.status(201).send({
          success: true,
          message: "Friend request sent successfully",
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.put("/friends/:requestId", VerifyToken, async (req, res) => {
      try {
        const requestId = req.params.requestId;
        const { action } = req.body;

        const friendRequest = await friendsCollection.findOne({
          _id: new ObjectId(requestId),
          status: "pending",
        });

        if (!friendRequest) {
          return res.status(404).send({ message: "Friend request not found" });
        }

        // Verify the logged-in user is the recipient
        if (friendRequest.recipientId.toString() !== req.user.userId) {
          return res
            .status(403)
            .send({ message: "Not authorized to respond to this request" });
        }

        await friendsCollection.updateOne(
          { _id: new ObjectId(requestId) },
          { $set: { status: action === "accept" ? "accepted" : "rejected" } }
        );

        // Create notification for the requester
        if (action === "accept") {
          await createNotification({
            type: "friend_request_accepted",
            senderId: new ObjectId(req.user.userId),
            recipientId: friendRequest.requesterId,
            message: "accepted your friend request"
          });
        }

        res.send({
          success: true,
          message: `Friend request ${action}ed successfully`,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.delete("/friends/:friendId", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const friendId = req.params.friendId;

        const result = await friendsCollection.deleteOne({
          $or: [
            {
              requesterId: new ObjectId(userId),
              recipientId: new ObjectId(friendId),
            },
            {
              requesterId: new ObjectId(friendId),
              recipientId: new ObjectId(userId),
            },
          ],
        });

        if (result.deletedCount === 0) {
          return res
            .status(404)
            .send({ message: "Friend relationship not found" });
        }

        res.send({
          success: true,
          message: "Friend removed successfully",
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.post("/stories", VerifyToken, async (req, res) => {
      try {
        const { image, content } = req.body;
        const userId = req.user.userId;

        const newStory = {
          userId: new ObjectId(userId),
          image,
          content: content || "",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        };

        const result = await storiesCollection.insertOne(newStory);

        res.status(201).send({
          success: true,
          message: "Story created successfully",
          story: {
            id: result.insertedId,
            ...newStory,
          },
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });


    

    app.get("/stories", VerifyToken, async (req, res) => {
      try {
        const stories = await storiesCollection
          .aggregate([
            {
              $lookup: {
                from: "users",
                localField: "userId",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: "$user" },
            {
              $project: {
                "user.password": 0,
              },
            },
            { $sort: { createdAt: -1 } },
          ])
          .toArray();

        res.send({
          success: true,
          stories,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get friend requests for current user
    app.get("/friends/requests", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const requests = await friendsCollection
          .aggregate([
            {
              $match: {
                recipientId: new ObjectId(userId),
                status: "pending",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "requesterId",
                foreignField: "_id",
                as: "requester",
              },
            },
            {
              $unwind: "$requester",
            },
            {
              $project: {
                "requester.password": 0,
              },
            },
            {
              $sort: { createdAt: -1 },
            },
          ])
          .toArray();

        res.send({
          success: true,
          requests,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get current user's friends
    app.get("/friends", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;

        const friends = await friendsCollection
          .aggregate([
            {
              $match: {
                $or: [
                  { requesterId: new ObjectId(userId), status: "accepted" },
                  { recipientId: new ObjectId(userId), status: "accepted" },
                ],
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "requesterId",
                foreignField: "_id",
                as: "requester",
              },
            },
            {
              $lookup: {
                from: "users",
                localField: "recipientId",
                foreignField: "_id",
                as: "recipient",
              },
            },
            {
              $project: {
                user: {
                  $cond: {
                    if: { $eq: ["$requesterId", new ObjectId(userId)] },
                    then: { $arrayElemAt: ["$recipient", 0] },
                    else: { $arrayElemAt: ["$requester", 0] },
                  },
                },
              },
            },
            {
              $project: {
                "user.password": 0,
              },
            },
          ])
          .toArray();

        res.send({
          success: true,
          friends,
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // **WEB SOCKET ENABLED MESSAGING APIs**

    // Get or create conversation by participant
    app.get("/conversations/participant/:participantId", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const participantId = req.params.participantId;

        // Check if conversation already exists
        const existingConversation = await conversationsCollection.findOne({
          participants: {
            $all: [new ObjectId(userId), new ObjectId(participantId)]
          }
        });

        if (existingConversation) {
          // Get participant details
          const participant = await usersCollection.findOne(
            { _id: new ObjectId(participantId) },
            { projection: { password: 0, email: 0 } }
          );

          return res.send({
            success: true,
            conversation: {
              ...existingConversation,
              participant: participant
            },
            message: "Conversation found"
          });
        }

        // Create new conversation
        const newConversation = {
          participants: [new ObjectId(userId), new ObjectId(participantId)],
          unreadCounts: [
            { userId: new ObjectId(userId), count: 0 },
            { userId: new ObjectId(participantId), count: 0 }
          ],
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const result = await conversationsCollection.insertOne(newConversation);
        const participant = await usersCollection.findOne(
          { _id: new ObjectId(participantId) },
          { projection: { password: 0, email: 0 } }
        );

        res.status(201).send({
          success: true,
          conversation: {
            _id: result.insertedId,
            ...newConversation,
            participant: participant
          },
          message: "New conversation created"
        });
      } catch (error) {
        console.error("Error getting conversation:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.post("/conversations", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { participantId } = req.body;

        if (!participantId) {
          return res.status(400).send({ message: "Participant ID is required" });
        }

        // Check if conversation already exists
        const existingConversation = await conversationsCollection.findOne({
          participants: {
            $all: [new ObjectId(userId), new ObjectId(participantId)]
          }
        });

        if (existingConversation) {
          return res.send({
            success: true,
            conversation: existingConversation,
            message: "Conversation already exists"
          });
        }

        // Create new conversation
        const newConversation = {
          participants: [new ObjectId(userId), new ObjectId(participantId)],
          unreadCounts: [
            { userId: new ObjectId(userId), count: 0 },
            { userId: new ObjectId(participantId), count: 0 }
          ],
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const result = await conversationsCollection.insertOne(newConversation);

        res.status(201).send({
          success: true,
          conversation: { _id: result.insertedId, ...newConversation },
          message: "New conversation created"
        });
      } catch (error) {
        console.error("Error creating conversation:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get user's conversations
    app.get("/conversations", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const conversations = await conversationsCollection
          .aggregate([
            {
              $match: {
                participants: new ObjectId(userId)
              }
            },
            {
              $lookup: {
                from: "users",
                localField: "participants",
                foreignField: "_id",
                as: "participantsData"
              }
            },
            {
              $project: {
                "participantsData.password": 0,
                "participantsData.email": 0
              }
            }
          ])
          .toArray();

        // Format response to show other participant
        const formattedConversations = conversations.map(conv => {
          const otherParticipant = conv.participantsData.find(
            p => p._id.toString() !== userId
          );
          
          return {
            _id: conv._id,
            participant: otherParticipant,
            lastMessage: conv.lastMessage,
            lastMessageAt: conv.lastMessageAt,
            unreadCounts: conv.unreadCounts,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt
          };
        });

        res.send({
          success: true,
          conversations: formattedConversations
        });
      } catch (error) {
        console.error("Error fetching conversations:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Send message with WebSocket
    app.post("/messages", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { conversationId, content, type = "text" } = req.body;

        if (!conversationId || !content) {
          return res.status(400).send({ 
            message: "Conversation ID and content are required" 
          });
        }

        // Verify user is part of the conversation
        const conversation = await conversationsCollection.findOne({
          _id: new ObjectId(conversationId),
          participants: new ObjectId(userId)
        });

        if (!conversation) {
          return res.status(403).send({ message: "Not authorized for this conversation" });
        }

        const newMessage = {
          conversationId: new ObjectId(conversationId),
          senderId: new ObjectId(userId),
          content,
          type,
          readBy: [new ObjectId(userId)],
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const result = await messagesCollection.insertOne(newMessage);

        // Get other participants
        const otherParticipants = conversation.participants.filter(
          participant => participant.toString() !== userId
        );

        // Update conversation
        await conversationsCollection.updateOne(
          { _id: new ObjectId(conversationId) },
          { 
            $set: { 
              lastMessage: content,
              lastMessageAt: new Date(),
              updatedAt: new Date()
            }
          }
        );

        // Increment unread counts for other participants
        for (const participantId of otherParticipants) {
          await conversationsCollection.updateOne(
            { 
              _id: new ObjectId(conversationId),
              "unreadCounts.userId": new ObjectId(participantId)
            },
            { 
              $inc: { "unreadCounts.$.count": 1 } 
            }
          );
        }

        // Get the created message with sender details
        const message = await messagesCollection
          .aggregate([
            { $match: { _id: result.insertedId } },
            {
              $lookup: {
                from: "users",
                localField: "senderId",
                foreignField: "_id",
                as: "sender"
              }
            },
            { $unwind: "$sender" },
            {
              $project: {
                "sender.password": 0,
                "sender.email": 0
              }
            }
          ])
          .toArray();

        const messageData = message[0];

        // **WEB SOCKET EMISSION**
        io.to(conversationId).emit('new_message', {
          conversationId,
          message: messageData
        });

        // Send push notification to offline users
        otherParticipants.forEach(participantId => {
          const isOnline = activeUsers.has(participantId.toString());
          if (!isOnline) {
            console.log(`User ${participantId} is offline, would send push notification`);
          }
        });

        res.status(201).send({
          success: true,
          message: messageData
        });
      } catch (error) {
        console.error("Error sending message:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get messages for a conversation
    app.get("/conversations/:conversationId/messages", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const conversationId = req.params.conversationId;
        const { page = 1, limit = 50 } = req.query;
        const skip = (page - 1) * parseInt(limit);

        // Verify user is part of the conversation
        const conversation = await conversationsCollection.findOne({
          _id: new ObjectId(conversationId),
          participants: new ObjectId(userId)
        });

        if (!conversation) {
          return res.status(403).send({ message: "Not authorized for this conversation" });
        }

        const messages = await messagesCollection
          .aggregate([
            { 
              $match: { 
                conversationId: new ObjectId(conversationId) 
              } 
            },
            {
              $lookup: {
                from: "users",
                localField: "senderId",
                foreignField: "_id",
                as: "sender"
              }
            },
            { $unwind: "$sender" },
            {
              $project: {
                "sender.password": 0,
                "sender.email": 0
              }
            },
            { $sort: { createdAt: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) }
          ])
          .toArray();

        // Mark messages as read when fetched
        await messagesCollection.updateMany(
          {
            conversationId: new ObjectId(conversationId),
            senderId: { $ne: new ObjectId(userId) },
            readBy: { $ne: new ObjectId(userId) }
          },
          {
            $push: { readBy: new ObjectId(userId) }
          }
        );

        // Reset unread count for this user
        await conversationsCollection.updateOne(
          {
            _id: new ObjectId(conversationId),
            "unreadCounts.userId": new ObjectId(userId)
          },
          {
            $set: { "unreadCounts.$.count": 0 }
          }
        );

        res.send({
          success: true,
          messages: messages.reverse(),
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: await messagesCollection.countDocuments({ 
              conversationId: new ObjectId(conversationId) 
            })
          }
        });
      } catch (error) {
        console.error("Error fetching messages:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Mark messages as read
    app.put("/conversations/:conversationId/read", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const conversationId = req.params.conversationId;

        // Mark all messages as read
        await messagesCollection.updateMany(
          {
            conversationId: new ObjectId(conversationId),
            senderId: { $ne: new ObjectId(userId) },
            readBy: { $ne: new ObjectId(userId) }
          },
          {
            $push: { readBy: new ObjectId(userId) }
          }
        );

        // Reset unread count
        await conversationsCollection.updateOne(
          {
            _id: new ObjectId(conversationId),
            "unreadCounts.userId": new ObjectId(userId)
          },
          {
            $set: { "unreadCounts.$.count": 0 }
          }
        );

        // Notify other participants via WebSocket
        io.to(conversationId).emit('messages_read', {
          conversationId,
          readBy: userId,
          readAt: new Date()
        });

        res.send({
          success: true,
          message: "Messages marked as read"
        });
      } catch (error) {
        console.error("Error marking messages as read:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Get online status of users
    app.get("/users/online-status/:userId", VerifyToken, async (req, res) => {
      try {
        const userId = req.params.userId;
        const isOnline = activeUsers.has(userId);
        
        res.send({
          success: true,
          isOnline,
          lastSeen: isOnline ? new Date() : null
        });
      } catch (error) {
        console.error("Error getting online status:", error);
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.delete("/stories/:id", VerifyToken, async (req, res) => {
      try {
        const storyId = req.params.id;
        const userId = req.user.userId;

        const story = await storiesCollection.findOne({
          _id: new ObjectId(storyId),
          userId: new ObjectId(userId),
        });

        if (!story) {
          return res
            .status(404)
            .send({ message: "Story not found or unauthorized" });
        }

        await storiesCollection.deleteOne({ _id: new ObjectId(storyId) });

        res.send({
          success: true,
          message: "Story deleted successfully",
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });
  } finally {
    // Client connection will remain open
  }
}

run().catch(console.dir);

app.get("/", async (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Social Media API Server</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; }
          .status { padding: 10px; border-radius: 5px; margin: 10px 0; }
          .online { background: #d4edda; color: #155724; }
          .info { background: #d1ecf1; color: #0c5460; }
          .streamable { background: #fff3cd; color: #856404; }
        </style>
      </head>
      <body>
        <h1>Social Media API Server is running! 🚀</h1>
        <div class="status online">
          <strong>WebSocket Status:</strong> Active with Call Support
        </div>
        <div class="status streamable">
          <strong>Streamable Video Hosting:</strong> Active
        </div>
        <div class="status info">
          <strong>Active Calls:</strong> ${activeCalls.size} | 
          <strong>Online Users:</strong> ${activeUsers.size}
        </div>
        <p>Server is ready for audio/video calls, real-time messaging, and video uploads.</p>
        <h3>Available Features:</h3>
        <ul>
          <li>✅ Real-time messaging</li>
          <li>✅ Audio calls</li>
          <li>✅ Video calls</li>
          <li>✅ Notifications</li>
          <li>✅ User status</li>
          <li>✅ WebRTC signaling</li>
          <li>✅ Streamable video uploads</li>
          <li>✅ Video URL importing</li>
        </ul>
        <h3>Streamable Video Endpoints:</h3>
        <ul>
          <li><code>POST /upload/video</code> - Upload base64 video</li>
          <li><code>POST /upload/video/url</code> - Import video from URL</li>
          <li><code>GET /video/:shortcode/status</code> - Get video status</li>
          <li><code>GET /video/:shortcode/embed</code> - Get embed info</li>
          <li><code>DELETE /video/:shortcode</code> - Delete video</li>
          <li><code>GET /videos/my</code> - Get user's videos</li>
          <li><code>GET /videos</code> - Get all public videos</li>
          <li><code>PUT /video/:shortcode/privacy</code> - Update video privacy</li>
          <li><code>GET /streamable/health</code> - Check Streamable connection</li>
        </ul>
      </body>
    </html>
  `);
});

// Use server.listen instead of app.listen
server.listen(port, () => {
  console.log(`🚀 Server is running on port: ${port}`);
  console.log(`🔌 WebSocket server is also running on port: ${port}`);
  console.log(`📞 Audio/Video Call support: ENABLED`);
  console.log(`💬 Real-time messaging: ENABLED`);
  console.log(`🔔 Notifications: ENABLED`);
  console.log(`🎥 Streamable Video Uploads: ENABLED`);
  console.log(`🌐 CORS enabled for: http://localhost:8081, http://localhost:19006, http://localhost:3000`);
  console.log(`\n📊 Initial Status:`);
  console.log(`   Active Calls: ${activeCalls.size}`);
  console.log(`   Online Users: ${activeUsers.size}`);
  console.log(`   Database: Connected`);
  console.log(`   Streamable: ${STREAMABLE_CONFIG.email ? 'Configured' : 'Not Configured'}`);
});
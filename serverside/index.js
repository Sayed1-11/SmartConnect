const express = require("express");
const cors = require("cors");
require("dotenv").config();
const axios = require('axios');
const port = process.env.PORT || 3000;
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");

const jwt = require("jsonwebtoken");
app.use(
  cors({
    origin: [
      "http://localhost:8081",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ 
  limit: '50mb', // Increase from default 100kb to 50mb
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '50mb' // Increase from default 100kb to 50mb
}));

app.use(express.json());
app.use(cookieParser());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.5iz2xl.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Database collections
let usersCollection, postsCollection, storiesCollection, friendsCollection;

async function run() {
  try {
    await client.connect();
    
    const database = client.db("social_media");
    usersCollection = database.collection("users");
    postsCollection = database.collection("posts");
    storiesCollection = database.collection("stories");
    friendsCollection = database.collection("friends");

    console.log("Connected to MongoDB");



    // JWT Authentication
app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN, {
        expiresIn: "72h",
      });
      res.cookie("token", token).send({ success: true, token });
    });

function VerifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log("Authorization header:", authHeader);
  
  if (!authHeader) {
    console.log("No authorization header found");
    return res.status(401).send({ message: "Access Denied - No Token Found" });
  }
  
  const token = authHeader.split(" ")[1];
  console.log("Extracted token:", token ? "Present" : "Missing");
  
  if (!token) {
    return res.status(401).send({ message: "Access Denied - Invalid Token Format" });
  }

  jwt.verify(token, process.env.ACCESS_TOKEN, (err, user) => {
    if (err) {
      console.log("JWT verification error:", err.message);
      return res.status(403).send({ message: "Invalid Token" });
    }
    console.log("JWT verified successfully for user:", user);
    req.user = user;
    next();
  });
}


app.post("/upload", VerifyToken, async (req, res) => {
  try {
    const { image } = req.body;

    if (!image) {
      return res.status(400).send({
        success: false,
        message: "No image data provided"
      });
    }

    console.log("Received image upload request");

    // Validate that it's a base64 image
    if (!image.startsWith('data:image/')) {
      return res.status(400).send({
        success: false,
        message: "Invalid image format. Expected base64 image data."
      });
    }

    // Extract base64 data
    const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    
    // Validate image size
    const imageSizeInBytes = (base64Data.length * 3) / 4;
    if (imageSizeInBytes > 10 * 1024 * 1024) {
      return res.status(413).send({
        success: false,
        message: "Image too large. Maximum size is 10MB."
      });
    }

    console.log("Uploading image to imgBB...");

    // Upload to imgBB
    const formData = new URLSearchParams();
    formData.append('image', base64Data);
    
    const imgBBResponse = await axios.post(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      formData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000
      }
    );

    console.log("imgBB response status:", imgBBResponse.status);

    if (imgBBResponse.data.success) {
      const imageUrl = imgBBResponse.data.data.url;
      
      res.status(200).send({
        success: true,
        message: "Image uploaded successfully",
        url: imageUrl, // Changed from imageUrl to url to match frontend expectation
        imgBBData: imgBBResponse.data.data
      });
    } else {
      throw new Error(imgBBResponse.data.error?.message || 'Image upload failed');
    }
  } catch (error) {
    console.error("Error uploading image to imgBB:", error);
    
    if (error.code === 'ECONNABORTED') {
      return res.status(408).send({
        success: false,
        message: "Image upload timeout. Please try again."
      });
    }
    
    if (error.response) {
      res.status(error.response.status).send({
        success: false,
        message: "Image upload service error",
        error: error.response.data.error?.message || 'Upload failed'
      });
    } else {
      res.status(500).send({
        success: false,
        message: "Server error during image upload",
        error: error.message
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
        const { name, email, password } = req.body;
        
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
          email,
          password: hashedPassword,
          profilePicture: "", // Empty by default
          bio: "", // Empty by default
          isProfileComplete: false, // Flag to check if profile needs completion
          createdAt: new Date(),
          updatedAt: new Date()
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
            isProfileComplete: false
          },
          requiresProfileCompletion: true // Flag to redirect to profile page
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
            isProfileComplete: !requiresProfileCompletion
          },
          requiresProfileCompletion: requiresProfileCompletion
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Update user profile
    app.put("/profile", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const { profilePicture, bio, name } = req.body;

        const updateData = {
          updatedAt: new Date()
        };

        // Only update fields that are provided
        if (profilePicture !== undefined) updateData.profilePicture = profilePicture;
        if (bio !== undefined) updateData.bio = bio;
        if (name !== undefined) updateData.name = name;

        // Check if profile is complete (has both profile picture and bio)
        const currentUser = await usersCollection.findOne({ _id: new ObjectId(userId) });
        const hasProfilePicture = profilePicture !== undefined ? profilePicture : currentUser.profilePicture;
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
          isProfileComplete: updateData.isProfileComplete
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
          userId: new ObjectId(userId)
        });

        // Get friends count
        const friendsCount = await friendsCollection.countDocuments({
          $or: [
            { requesterId: new ObjectId(userId), status: "accepted" },
            { recipientId: new ObjectId(userId), status: "accepted" }
          ]
        });

        res.send({
          success: true,
          user: {
            ...user,
            postsCount,
            friendsCount
          }
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
              email: 0 // Don't expose email in public profile
            } 
          }
        );

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        // Get user's posts count
        const postsCount = await postsCollection.countDocuments({
          userId: new ObjectId(userId)
        });

        // Get friends count
        const friendsCount = await friendsCollection.countDocuments({
          $or: [
            { requesterId: new ObjectId(userId), status: "accepted" },
            { recipientId: new ObjectId(userId), status: "accepted" }
          ]
        });

        // Check if current user is friends with this user
        const isFriend = await friendsCollection.findOne({
          $or: [
            { 
              requesterId: new ObjectId(req.user.userId), 
              recipientId: new ObjectId(userId),
              status: "accepted"
            },
            { 
              requesterId: new ObjectId(userId), 
              recipientId: new ObjectId(req.user.userId),
              status: "accepted"
            }
          ]
        });

        res.send({
          success: true,
          user: {
            ...user,
            postsCount,
            friendsCount,
            isFriend: !!isFriend
          }
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Post APIs
app.post("/posts", VerifyToken, async (req, res) => {
  try {
    const { content, image, privacy = "public" } = req.body;
    const userId = req.user.userId;

    // Validate required fields
    if (!content && !image) {
      return res.status(400).send({
        success: false,
        message: "Post must contain either content or image"
      });
    }

    let imageUrl = "";
    let imageData = null;

    // If image is provided as base64, upload it first
    if (image && image.startsWith('data:image/')) {
      console.log("Detected base64 image, uploading to imgBB...");
      
      try {
        // Upload directly to imgBB instead of internal endpoint
        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        
        const formData = new URLSearchParams();
        formData.append('image', base64Data);
        
        const imgBBResponse = await axios.post(
          `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
          formData,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 30000
          }
        );

        if (imgBBResponse.data.success) {
          const imgBBData = imgBBResponse.data.data;
          imageUrl = imgBBData.url;
          imageData = {
            url: imgBBData.url,
            thumbUrl: imgBBData.thumb?.url || imgBBData.url,
            mediumUrl: imgBBData.medium?.url || imgBBData.url,
            deleteUrl: imgBBData.delete_url,
            imageId: imgBBData.id
          };
          console.log("Image uploaded successfully:", imageUrl);
        }
      } catch (uploadError) {
        console.error("Failed to upload image:", uploadError);
        // Continue without image if upload fails
      }
    } else if (image) {
      // If it's already a URL, use it directly
      imageUrl = image;
    }

    const newPost = {
      userId: new ObjectId(userId),
      content: content || "",
      image: imageUrl,
      imageData: imageData,
      privacy,
      likes: [],
      comments: [],
      shares: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    console.log("Creating post with data:", {
      content: newPost.content,
      hasImage: !!newPost.image,
      privacy: newPost.privacy
    });

    const result = await postsCollection.insertOne(newPost);
    
    // Populate user details
    const post = await postsCollection.aggregate([
      { $match: { _id: result.insertedId } },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user"
        }
      },
      { $unwind: "$user" },
      {
        $project: {
          "user.password": 0,
          "user.email": 0
        }
      }
    ]).toArray();

    console.log("Post created successfully:", post[0]._id);

    res.status(201).send({
      success: true,
      message: "Post created successfully",
      post: post[0]
    });
  } catch (error) {
    console.error("Error creating post:", error);
    res.status(500).send({ 
      success: false,
      message: "Server error while creating post", 
      error: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});


// Get posts with image support
app.get("/posts", VerifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 10, userId } = req.query;
    const skip = (page - 1) * parseInt(limit);

    // Build match query
    const matchQuery = {};
    if (userId) {
      matchQuery.userId = new ObjectId(userId);
    }

    const posts = await postsCollection.aggregate([
      { $match: matchQuery },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user"
        }
      },
      { $unwind: "$user" },
      {
        $project: {
          "user.password": 0,
          "user.email": 0
        }
      },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) }
    ]).toArray();

    res.send({
      success: true,
      posts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: await postsCollection.countDocuments(matchQuery)
      }
    });
  } catch (error) {
    res.status(500).send({ message: "Server error", error: error.message });
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
      userId: new ObjectId(userId) 
    });

    if (!post) {
      return res.status(404).send({ message: "Post not found or unauthorized" });
    }

    let imageUrl = post.image;
    let imageData = post.imageData;

    // Handle image update
    if (image && image !== post.image) {
      if (image.startsWith('data:image/')) {
        // New base64 image - upload it
        try {
          const uploadResponse = await axios.post(
            `http://localhost:${port}/upload-base64`,
            { image },
            {
              headers: {
                'Authorization': req.headers.authorization,
                'Content-Type': 'application/json'
              }
            }
          );

          if (uploadResponse.data.success) {
            imageUrl = uploadResponse.data.imageUrl;
            imageData = {
              url: uploadResponse.data.imageUrl,
              thumbUrl: uploadResponse.data.thumbUrl,
              mediumUrl: uploadResponse.data.mediumUrl,
              deleteUrl: uploadResponse.data.deleteUrl,
              imageId: uploadResponse.data.imageId
            };
          }
        } catch (uploadError) {
          console.error("Failed to upload new image:", uploadError);
          // Keep old image if upload fails
        }
      } else {
        // It's already a URL
        imageUrl = image;
        imageData = null; // Reset image data for external URLs
      }
    }

    const updateData = {
      content: content !== undefined ? content : post.content,
      image: imageUrl,
      imageData: imageData,
      privacy: privacy || post.privacy,
      updatedAt: new Date()
    };

    await postsCollection.updateOne(
      { _id: new ObjectId(postId) },
      { $set: updateData }
    );

    res.send({
      success: true,
      message: "Post updated successfully"
    });
  } catch (error) {
    res.status(500).send({ message: "Server error", error: error.message });
  }
});

    app.get("/posts/:id", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;

        const post = await postsCollection.aggregate([
          { $match: { _id: new ObjectId(postId) } },
          {
            $lookup: {
              from: "users",
              localField: "userId",
              foreignField: "_id",
              as: "user"
            }
          },
          { $unwind: "$user" },
          {
            $project: {
              "user.password": 0
            }
          }
        ]).toArray();

        if (!post.length) {
          return res.status(404).send({ message: "Post not found" });
        }

        res.send({
          success: true,
          post: post[0]
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
          userId: new ObjectId(userId) 
        });

        if (!post) {
          return res.status(404).send({ message: "Post not found or unauthorized" });
        }

        await postsCollection.deleteOne({ _id: new ObjectId(postId) });

        res.send({
          success: true,
          message: "Post deleted successfully"
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Like/Unlike Post
    app.post("/posts/:id/like", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const userId = req.user.userId;

        const post = await postsCollection.findOne({ _id: new ObjectId(postId) });
        if (!post) {
          return res.status(404).send({ message: "Post not found" });
        }

        const hasLiked = post.likes.some(like => like.userId.toString() === userId);

        if (hasLiked) {
          // Unlike
          await postsCollection.updateOne(
            { _id: new ObjectId(postId) },
            { $pull: { likes: { userId: new ObjectId(userId) } } }
          );
          res.send({ success: true, message: "Post unliked", liked: false });
        } else {
          // Like
          await postsCollection.updateOne(
            { _id: new ObjectId(postId) },
            { 
              $push: { 
                likes: { 
                  userId: new ObjectId(userId), 
                  likedAt: new Date() 
                } 
              } 
            }
          );
          res.send({ success: true, message: "Post liked", liked: true });
        }
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Comment on Post
    app.post("/posts/:id/comment", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const userId = req.user.userId;
        const { content } = req.body;

        if (!content) {
          return res.status(400).send({ message: "Comment content is required" });
        }

        const comment = {
          _id: new ObjectId(),
          userId: new ObjectId(userId),
          content,
          createdAt: new Date()
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

        res.send({
          success: true,
          message: "Comment added successfully",
          comment: {
            ...comment,
            user: {
              name: user.name,
              profilePicture: user.profilePicture
            }
          }
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Share Post
    app.post("/posts/:id/share", VerifyToken, async (req, res) => {
      try {
        const postId = req.params.id;
        const userId = req.user.userId;

        // Increment share count
        await postsCollection.updateOne(
          { _id: new ObjectId(postId) },
          { $inc: { shares: 1 } }
        );

        // Create a new shared post
        const originalPost = await postsCollection.findOne({ _id: new ObjectId(postId) });
        
        const sharedPost = {
          userId: new ObjectId(userId),
          content: `Shared: ${originalPost.content}`,
          originalPostId: new ObjectId(postId),
          isShared: true,
          likes: [],
          comments: [],
          shares: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        await postsCollection.insertOne(sharedPost);

        res.send({
          success: true,
          message: "Post shared successfully"
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Friend System APIs
    app.get("/users/search", VerifyToken, async (req, res) => {
      try {
        const { q } = req.query;
        
        if (!q) {
          return res.status(400).send({ message: "Search query is required" });
        }

        const users = await usersCollection.find({
          $or: [
            { name: { $regex: q, $options: "i" } },
            { email: { $regex: q, $options: "i" } }
          ]
        }, {
          projection: {
            password: 0
          }
        }).toArray();

        res.send({
          success: true,
          users
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.post("/friends/:friendId", VerifyToken, async (req, res) => {
      try {
        const userId = req.user.userId;
        const friendId = req.params.friendId;

        if (userId === friendId) {
          return res.status(400).send({ message: "Cannot add yourself as friend" });
        }

        // Check if friend request already exists
        const existingRequest = await friendsCollection.findOne({
          $or: [
            { requesterId: new ObjectId(userId), recipientId: new ObjectId(friendId) },
            { requesterId: new ObjectId(friendId), recipientId: new ObjectId(userId) }
          ]
        });

        if (existingRequest) {
          return res.status(400).send({ message: "Friend request already exists" });
        }

        // Create friend request
        const friendRequest = {
          requesterId: new ObjectId(userId),
          recipientId: new ObjectId(friendId),
          status: "pending", // pending, accepted, rejected
          createdAt: new Date()
        };

        await friendsCollection.insertOne(friendRequest);

        res.status(201).send({
          success: true,
          message: "Friend request sent successfully"
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.put("/friends/:friendId", VerifyToken, async (req, res) => {
      try {
        const friendId = req.params.friendId;
        const userId = req.user.userId;
        const { action } = req.body; // "accept" or "reject"

        const friendRequest = await friendsCollection.findOne({
          requesterId: new ObjectId(friendId),
          recipientId: new ObjectId(userId),
          status: "pending"
        });

        if (!friendRequest) {
          return res.status(404).send({ message: "Friend request not found" });
        }

        await friendsCollection.updateOne(
          { _id: friendRequest._id },
          { $set: { status: action === "accept" ? "accepted" : "rejected" } }
        );

        res.send({
          success: true,
          message: `Friend request ${action}ed successfully`
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
            { requesterId: new ObjectId(userId), recipientId: new ObjectId(friendId) },
            { requesterId: new ObjectId(friendId), recipientId: new ObjectId(userId) }
          ]
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({ message: "Friend relationship not found" });
        }

        res.send({
          success: true,
          message: "Friend removed successfully"
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    // Story APIs
    app.post("/stories", VerifyToken, async (req, res) => {
      try {
        const { image, content } = req.body;
        const userId = req.user.userId;

        const newStory = {
          userId: new ObjectId(userId),
          image,
          content: content || "",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
        };

        const result = await storiesCollection.insertOne(newStory);

        res.status(201).send({
          success: true,
          message: "Story created successfully",
          story: {
            id: result.insertedId,
            ...newStory
          }
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });

    app.get("/stories", VerifyToken, async (req, res) => {
      try {
        const stories = await storiesCollection.aggregate([
          {
            $lookup: {
              from: "users",
              localField: "userId",
              foreignField: "_id",
              as: "user"
            }
          },
          { $unwind: "$user" },
          {
            $project: {
              "user.password": 0
            }
          },
          { $sort: { createdAt: -1 } }
        ]).toArray();

        res.send({
          success: true,
          stories
        });
      } catch (error) {
        res.status(500).send({ message: "Server error", error: error.message });
      }
    });
// Get friend requests for current user
app.get("/friends/requests", VerifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const requests = await friendsCollection.aggregate([
      {
        $match: {
          recipientId: new ObjectId(userId),
          status: "pending"
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "requesterId",
          foreignField: "_id",
          as: "requester"
        }
      },
      {
        $unwind: "$requester"
      },
      {
        $project: {
          "requester.password": 0
        }
      },
      {
        $sort: { createdAt: -1 }
      }
    ]).toArray();

    res.send({
      success: true,
      requests
    });
  } catch (error) {
    res.status(500).send({ message: "Server error", error: error.message });
  }
});

// Get current user's friends
app.get("/friends", VerifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const friends = await friendsCollection.aggregate([
      {
        $match: {
          $or: [
            { requesterId: new ObjectId(userId), status: "accepted" },
            { recipientId: new ObjectId(userId), status: "accepted" }
          ]
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "requesterId",
          foreignField: "_id",
          as: "requester"
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "recipientId",
          foreignField: "_id",
          as: "recipient"
        }
      },
      {
        $project: {
          user: {
            $cond: {
              if: { $eq: ["$requesterId", new ObjectId(userId)] },
              then: { $arrayElemAt: ["$recipient", 0] },
              else: { $arrayElemAt: ["$requester", 0] }
            }
          }
        }
      },
      {
        $project: {
          "user.password": 0
        }
      }
    ]).toArray();

    res.send({
      success: true,
      friends
    });
  } catch (error) {
    res.status(500).send({ message: "Server error", error: error.message });
  }
});
    app.delete("/stories/:id", VerifyToken, async (req, res) => {
      try {
        const storyId = req.params.id;
        const userId = req.user.userId;

        const story = await storiesCollection.findOne({
          _id: new ObjectId(storyId),
          userId: new ObjectId(userId)
        });

        if (!story) {
          return res.status(404).send({ message: "Story not found or unauthorized" });
        }

        await storiesCollection.deleteOne({ _id: new ObjectId(storyId) });

        res.send({
          success: true,
          message: "Story deleted successfully"
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
  res.send("Social Media API Server is running!");
});

app.listen(port, () => {
  console.log(`Server is running on port: ${port}`);
});
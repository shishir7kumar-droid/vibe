const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

// Configure Cloudinary with your credentials
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Multer Storage for Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'vibe_art', // The name of the folder in Cloudinary
    allowed_formats: ['jpg', 'jpeg', 'webp'],
    transformation: [{ width: 1000, height: 1000, crop: 'limit' }] // Resize for consistency
  },
});

module.exports = {
  cloudinary,
  storage
};

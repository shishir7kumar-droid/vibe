const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
  aboutVibe: {
    type: String,
    default: 'Empowering artists to showcase their vision to the local and global stage.'
  },
  instagramUrl: {
    type: String,
    default: '#'
  },
  twitterUrl: {
    type: String,
    default: '#'
  },
  linkedinUrl: {
    type: String,
    default: '#'
  },
  devName: {
    type: String,
    default: 'R.K. Hans'
  },
  whatsapp: {
    type: String,
    default: '+917302125050'
  },
  email: {
    type: String,
    default: '01hans.rk@gmail.com'
  }
});

module.exports = mongoose.model('Settings', SettingsSchema);

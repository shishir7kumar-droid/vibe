const express = require('express');
const path = require('path');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const connectDB = require('./config/db');
const Art = require('./models/Art');
const User = require('./models/User');
const Settings = require('./models/Settings');
const { storage, cloudinary } = require('./config/cloudinary');

const app = express();

// Connect to Database
connectDB();

// Seed Default Settings
const seedSettings = async () => {
  try {
    const settings = await Settings.findOne();
    if (!settings) {
      await Settings.create({});
    }
  } catch (err) {
    console.error('Error seeding settings:', err);
  }
};
seedSettings();

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "cdn.jsdelivr.net", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "res.cloudinary.com"],
    },
  },
}));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'vibe_secret_fallback',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));

// Admin Authorization Middleware
const isAdmin = (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const isVisitor = cookies.includes('session=visitor-session-active');

  if (isVisitor || (req.session && req.session.isLoggedIn)) {
    return next();
  }
  
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
    return res.status(401).json({ error: 'Session expired. Please login again.' });
  }
  res.redirect('/login');
};

// Global view variables
app.use(async (req, res, next) => {
  const cookies = req.headers.cookie || '';
  const isVisitor = cookies.includes('session=visitor-session-active');
  
  res.locals.isAuthenticated = (req.session && req.session.isLoggedIn) || isVisitor;
  res.locals.isVisitor = isVisitor;

  try {
    const settings = await Settings.findOne();
    res.locals.settings = settings || {};
  } catch (err) {
    res.locals.settings = {};
  }
  next();
});

// Set View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Use Cloudinary Storage for Multer
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Helper to block visitor actions
const blockVisitor = (req, res, next) => {
  const cookies = req.headers.cookie || '';
  if (cookies.includes('session=visitor-session-active')) {
    return res.status(403).send('Action disabled in Demo Mode');
  }
  next();
};

// --- Public Routes ---

app.get('/', async (req, res, next) => {
  try {
    const cookies = req.headers.cookie || '';
    const isVisitor = cookies.includes('session=visitor-session-active');

    // If visitor, use session-based showcase simulation
    if (isVisitor && req.session.visitorFeatured) {
      const featuredArt = await Art.find({ _id: { $in: req.session.visitorFeatured } });
      return res.render('index', { featuredArt });
    }

    const featuredArt = await Art.find({ isFeatured: true }).sort({ createdAt: -1 }).limit(9);
    res.render('index', { featuredArt: featuredArt || [] });
  } catch (err) {
    next(err);
  }
});

app.get('/collection', async (req, res, next) => {
  try {
    const artPieces = await Art.find().sort({ createdAt: -1 });
    res.render('collection', { artPieces });
  } catch (err) {
    next(err);
  }
});

app.get('/login', (req, res) => {
  const cookies = req.headers.cookie || '';
  if (req.session.isLoggedIn || cookies.includes('session=visitor-session-active')) {
    return res.redirect('/admin');
  }
  res.render('login', { error: null });
});

app.post('/login', async (req, res, next) => {
  const { username, password } = req.body;
  const userInput = (username || '').toLowerCase().trim();
  const passInput = (password || '').trim();

  // 1. Visitor Login (Simulated permissions, No DB User lookup)
  if (userInput === 'visitor' && passInput === 'visitor') {
    res.cookie('session', 'visitor-session-active', {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 // 1 day
    });
    
    req.session.isLoggedIn = true;
    req.session.isVisitor = true;
    return req.session.save(() => res.redirect('/admin'));
  }

  try {
    // 2. Standard Admin Login (Fall back to MongoDB lookup)
    const user = await User.findOne({ username: { $regex: new RegExp(`^${userInput}$`, 'i') } });
    if (!user) return res.render('login', { error: 'Invalid username or password.' });

    const isMatch = await bcrypt.compare(passInput, user.password);
    if (!isMatch) return res.render('login', { error: 'Invalid username or password.' });

    req.session.isLoggedIn = true;
    req.session.isVisitor = false;
    req.session.user = user;
    req.session.save(() => res.redirect('/admin'));
  } catch (err) {
    next(err);
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('session');
  if (req.session) {
    req.session.destroy(() => res.redirect('/'));
  } else {
    res.redirect('/');
  }
});

// --- Admin Routes (Protected) ---
app.get('/admin', isAdmin, async (req, res, next) => {
  try {
    const cookies = req.headers.cookie || '';
    const isVisitor = cookies.includes('session=visitor-session-active');
    let artPieces = await Art.find().sort({ createdAt: -1 });

    // If visitor, override isFeatured based on session simulation
    if (isVisitor) {
      if (!req.session.visitorFeatured) {
        // Initialize with current DB featured items for the first time
        const dbFeatured = await Art.find({ isFeatured: true });
        req.session.visitorFeatured = dbFeatured.map(a => a._id.toString());
      }
      artPieces = artPieces.map(art => {
        const plainArt = art.toObject();
        plainArt.isFeatured = req.session.visitorFeatured.includes(art._id.toString());
        return plainArt;
      });
    }

    res.render('admin/dashboard', { artPieces });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/upload', isAdmin, blockVisitor, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).send('Please upload an image.');
    }
    const { title, description } = req.body;
    const imageUrl = req.file.path;
    const cloudinaryId = req.file.filename;
    const newArt = new Art({ title, description, imageUrl, cloudinaryId, isFeatured: false });
    await newArt.save();
    res.redirect('/admin?success=true');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/delete/:id', isAdmin, blockVisitor, async (req, res, next) => {
  try {
    const art = await Art.findById(req.params.id);
    if (!art) return res.status(404).send('Art piece not found.');
    await cloudinary.uploader.destroy(art.cloudinaryId);
    await Art.findByIdAndDelete(req.params.id);
    res.redirect('/admin?deleted=true');
  } catch (err) {
    next(err);
  }
});

app.get('/admin/edit/:id', isAdmin, async (req, res, next) => {
  try {
    const art = await Art.findById(req.params.id);
    if (!art) return res.status(404).send('Art piece not found.');
    res.render('admin/edit', { art });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/edit/:id', isAdmin, blockVisitor, async (req, res, next) => {
  try {
    const { title, description } = req.body;
    await Art.findByIdAndUpdate(req.params.id, { title, description });
    res.redirect('/admin?updated=true');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/change-password', isAdmin, blockVisitor, async (req, res, next) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 5) return res.redirect('/admin?error=password_too_short');
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    await User.findByIdAndUpdate(req.session.user._id, { password: hashedPassword });
    res.redirect('/admin?password_updated=true');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/settings', isAdmin, blockVisitor, async (req, res, next) => {
  try {
    const { aboutVibe, instagramUrl, twitterUrl, linkedinUrl, devName, whatsapp, email } = req.body;
    await Settings.findOneAndUpdate({}, { aboutVibe, instagramUrl, twitterUrl, linkedinUrl, devName, whatsapp, email }, { upsert: true });
    res.redirect('/admin?settings_updated=true');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/toggle-showcase', isAdmin, async (req, res, next) => {
  try {
    const { id } = req.body;
    const cookies = req.headers.cookie || '';
    const isVisitor = cookies.includes('session=visitor-session-active');

    // Visitor Simulation Logic
    if (isVisitor) {
      if (!req.session.visitorFeatured) {
        const dbFeatured = await Art.find({ isFeatured: true });
        req.session.visitorFeatured = dbFeatured.map(a => a._id.toString());
      }

      if (req.session.visitorFeatured.includes(id)) {
        req.session.visitorFeatured = req.session.visitorFeatured.filter(fid => fid !== id);
      } else {
        if (req.session.visitorFeatured.length >= 9) {
          return res.status(400).json({ error: 'Showcase is full (Max 9 items)' });
        }
        req.session.visitorFeatured.push(id);
      }
      return req.session.save(() => res.json({ success: true, isFeatured: req.session.visitorFeatured.includes(id) }));
    }

    // Real Admin logic
    const art = await Art.findById(id);
    if (!art) return res.status(404).json({ error: 'Art piece not found' });

    if (!art.isFeatured) {
      const showcaseCount = await Art.countDocuments({ isFeatured: true });
      if (showcaseCount >= 9) return res.status(400).json({ error: 'Showcase is full (Max 9 items)' });
      art.isFeatured = true;
    } else {
      art.isFeatured = false;
    }

    await art.save();
    res.json({ success: true, isFeatured: art.isFeatured });
  } catch (err) {
    next(err);
  }
});

// Error Boundary
app.use((err, req, res, next) => {
  console.error('SERVER_ERROR:', err);
  if (err.http_code || err.name === 'MulterError') {
    return res.status(500).send('<div style="text-align: center; padding: 50px;"><h2>Upload Failed</h2><a href="/admin">Back to Dashboard</a></div>');
  }
  res.status(500).send('<div style="text-align: center; padding: 50px;"><h2>Something went wrong!</h2><a href="/">Return Home</a></div>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

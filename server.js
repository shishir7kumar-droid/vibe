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
  if (req.session.isLoggedIn) {
    next();
  } else {
    // If it's an AJAX request, send 401 instead of redirecting
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
      return res.status(401).json({ error: 'Session expired. Please login again.' });
    }
    res.redirect('/login');
  }
};

// Global view variables
app.use(async (req, res, next) => {
  res.locals.isAuthenticated = req.session.isLoggedIn;
  try {
    const settings = await Settings.findOne();
    res.locals.settings = settings || {};
  } catch (err) {
    console.error('Error fetching global settings:', err);
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

// --- Public Routes ---

app.get('/', async (req, res, next) => {
  try {
    // Only fetch artworks explicitly set to isFeatured: true
    const featuredArt = await Art.find({ isFeatured: true })
      .sort({ createdAt: -1 })
      .limit(9);
    
    // Pass featuredArt to the view, an empty array if none found
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
  if (req.session.isLoggedIn) return res.redirect('/admin');
  res.render('login', { error: null });
});

app.post('/login', async (req, res, next) => {
  const { username, password } = req.body;
  try {
    const userCount = await User.countDocuments();

    if (userCount === 0) {
      if (username === 'admin' && password === 'admin') {
        const hashedPassword = await bcrypt.hash('admin', 12);
        const newUser = new User({ username: 'admin', password: hashedPassword });
        await newUser.save();
        req.session.isLoggedIn = true;
        req.session.user = newUser;
        return res.redirect('/admin');
      } else {
        return res.render('login', { error: 'Invalid credentials. Use admin/admin for first login.' });
      }
    }

    const user = await User.findOne({ username });
    if (!user) return res.render('login', { error: 'Invalid username or password.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.render('login', { error: 'Invalid username or password.' });

    req.session.isLoggedIn = true;
    req.session.user = user;
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error(err);
    res.redirect('/');
  });
});

// --- Admin Routes (Protected) ---

app.get('/admin', isAdmin, async (req, res, next) => {
  try {
    const artPieces = await Art.find().sort({ createdAt: -1 });
    res.render('admin/dashboard', { artPieces });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/upload', isAdmin, upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).send('Please upload an image.');
    }
    const { title, description } = req.body;
    const imageUrl = req.file.path;
    const cloudinaryId = req.file.filename;
    const newArt = new Art({ title, description, imageUrl, cloudinaryId, order: 99 });
    await newArt.save();
    res.redirect('/admin?success=true');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/delete/:id', isAdmin, async (req, res, next) => {
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

app.post('/admin/edit/:id', isAdmin, async (req, res, next) => {
  try {
    const { title, description } = req.body;
    await Art.findByIdAndUpdate(req.params.id, { title, description });
    res.redirect('/admin?updated=true');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/change-password', isAdmin, async (req, res, next) => {
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

app.post('/admin/settings', isAdmin, async (req, res, next) => {
  try {
    const { aboutVibe, instagramUrl, twitterUrl, linkedinUrl, devName, whatsapp, email } = req.body;
    await Settings.findOneAndUpdate({}, { aboutVibe, instagramUrl, twitterUrl, linkedinUrl, devName, whatsapp, email }, { upsert: true });
    res.redirect('/admin?settings_updated=true');
  } catch (err) {
    next(err);
  }
});

// Direct Toggle Showcase Route (Add/Remove)
app.post('/admin/toggle-showcase', isAdmin, async (req, res, next) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'No ID provided' });

    const art = await Art.findById(id);
    if (!art) return res.status(404).json({ error: 'Art piece not found' });

    // If NOT featured
    if (!art.isFeatured) {
      // Check limit: count how many are featured
      const showcaseCount = await Art.countDocuments({ isFeatured: true });
      if (showcaseCount >= 9) {
        return res.status(400).json({ error: 'Showcase is full (Max 9 items)' });
      }
      art.isFeatured = true;
    } else {
      // If ALREADY featured, remove it
      art.isFeatured = false;
    }

    await art.save();
    res.json({ success: true, isFeatured: art.isFeatured });
  } catch (err) {
    next(err);
  }
});

// Simple Error Boundary
app.use((err, req, res, next) => {
  console.error('SERVER_ERROR:', err);
  
  // Custom message for Cloudinary/Upload errors
  if (err.http_code || err.name === 'MulterError') {
    return res.status(500).send(`
      <div style="text-align: center; padding: 50px; font-family: sans-serif;">
        <h2 style="color: #dc3545;">Upload Failed</h2>
        <p>Something went wrong while connecting to Cloudinary. Please check your API keys or image format.</p>
        <a href="/admin" style="color: #007bff; text-decoration: none;">&larr; Back to Dashboard</a>
      </div>
    `);
  }

  res.status(500).send(`
    <div style="text-align: center; padding: 50px; font-family: sans-serif;">
      <h2 style="color: #dc3545;">Something went wrong!</h2>
      <p>${err.message || 'An internal server error occurred.'}</p>
      <a href="/" style="color: #007bff; text-decoration: none;">Return Home</a>
    </div>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

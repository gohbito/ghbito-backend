const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const multer = require('multer');
require('dotenv').config();

const app = express();

// ==================== CONFIGURATION CORS ====================
app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Firebase Admin SDK
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    })
});
const db = admin.firestore();

// Multer
const upload = multer({ storage: multer.memoryStorage() });

// ==================== MIDDLEWARE AUTH ====================
async function verifyToken(req, res, next) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Non authentifié' });
    }
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        req.isAdmin = decodedToken.email === 'gohbito04@gmail.com';
        next();
    } catch (error) {
        res.status(401).json({ error: 'Token invalide' });
    }
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
    res.json({ 
        message: '🚀 Serveur GHBITO en ligne !',
        endpoints: [
            'GET  /api/products',
            'GET  /api/categories',
            'GET  /api/zones',
            'GET  /api/products/:id/reviews',
            'POST /api/orders',
            'GET  /api/orders/my',
            'GET  /api/admin/stats',
            'GET  /api/admin/reviews  ← NOUVEAU',
            'DELETE /api/products/:id/reviews/:id  ← NOUVEAU'
        ]
    });
});

// 1. Produits
app.get('/api/products', async (req, res) => {
    try {
        const snapshot = await db.collection('products').orderBy('createdAt', 'desc').get();
        const products = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            products.push({ 
                id: doc.id, 
                ...data,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
                updatedAt: data.updatedAt ? data.updatedAt.toDate().toISOString() : null
            });
        });
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Catégories
app.get('/api/categories', async (req, res) => {
    try {
        const snapshot = await db.collection('categories').orderBy('name').get();
        const categories = [];
        snapshot.forEach(doc => {
            categories.push({ id: doc.id, ...doc.data() });
        });
        res.json(categories);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Zones
app.get('/api/zones', async (req, res) => {
    try {
        const snapshot = await db.collection('zones').orderBy('order', 'asc').get();
        const zones = [];
        snapshot.forEach(doc => {
            zones.push({ id: doc.id, ...doc.data() });
        });
        res.json(zones);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Avis d'un produit
app.get('/api/products/:id/reviews', async (req, res) => {
    try {
        const snapshot = await db.collection('reviews')
            .where('productId', '==', req.params.id)
            .orderBy('createdAt', 'desc')
            .get();
        const reviews = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            reviews.push({ 
                id: doc.id, 
                ...data,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
            });
        });
        res.json(reviews);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Ajouter un avis
app.post('/api/products/:id/reviews', verifyToken, async (req, res) => {
    try {
        const productId = req.params.id;
        const { rating, text } = req.body;
        
        const ordersSnapshot = await db.collection('orders')
            .where('userId', '==', req.user.uid)
            .where('status', '==', 'delivered')
            .get();
        
        let hasPurchased = false;
        ordersSnapshot.forEach(order => {
            const items = order.data().items || [];
            if (items.some(item => item.productId === productId)) {
                hasPurchased = true;
            }
        });
        
        if (!hasPurchased) {
            return res.status(403).json({ error: 'Vous devez acheter ce produit pour laisser un avis' });
        }
        
        const existingReview = await db.collection('reviews')
            .where('productId', '==', productId)
            .where('userId', '==', req.user.uid)
            .get();
        
        if (!existingReview.empty) {
            return res.status(400).json({ error: 'Vous avez déjà laissé un avis pour ce produit' });
        }
        
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        const userName = userDoc.exists ? userDoc.data().name : req.user.email;
        
        const reviewData = {
            productId,
            userId: req.user.uid,
            userName: userName,
            rating: parseInt(rating),
            text: text,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        await db.collection('reviews').add(reviewData);
        
        const allReviews = await db.collection('reviews')
            .where('productId', '==', productId)
            .get();
        
        let totalRating = 0;
        allReviews.forEach(doc => { totalRating += doc.data().rating; });
        
        const avgRating = totalRating / allReviews.size;
        const reviewCount = allReviews.size;
        
        await db.collection('products').doc(productId).update({
            avgRating: avgRating,
            reviewCount: reviewCount
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. SUPPRIMER UN AVIS (NOUVEAU - ADMIN)
app.delete('/api/products/:productId/reviews/:reviewId', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const { productId, reviewId } = req.params;
        
        // Supprimer l'avis
        await db.collection('reviews').doc(reviewId).delete();
        
        // Recalculer la moyenne du produit
        const allReviews = await db.collection('reviews')
            .where('productId', '==', productId)
            .get();
        
        let totalRating = 0;
        let reviewCount = 0;
        allReviews.forEach(doc => {
            totalRating += doc.data().rating;
            reviewCount++;
        });
        
        const avgRating = reviewCount > 0 ? totalRating / reviewCount : 0;
        
        await db.collection('products').doc(productId).update({
            avgRating: avgRating,
            reviewCount: reviewCount,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. TOUS LES AVIS POUR ADMIN (NOUVEAU)
app.get('/api/admin/reviews', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const snapshot = await db.collection('reviews').orderBy('createdAt', 'desc').get();
        const reviews = [];
        
        for (const doc of snapshot.docs) {
            const data = doc.data();
            // Récupérer le nom du produit
            const productDoc = await db.collection('products').doc(data.productId).get();
            const productName = productDoc.exists ? productDoc.data().name : 'Produit inconnu';
            
            reviews.push({
                id: doc.id,
                productId: data.productId,
                productName: productName,
                userId: data.userId,
                userName: data.userName,
                rating: data.rating,
                text: data.text,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
            });
        }
        
        res.json(reviews);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ROUTES ADMIN PRODUITS ====================

app.post('/api/upload', verifyToken, upload.single('image'), async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    if (!req.file) return res.status(400).json({ error: 'Aucune image' });
    
    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream({
                folder: 'ghbito/products',
                transformation: [{ width: 800, height: 800, crop: 'limit' }]
            }, (error, result) => error ? reject(error) : resolve(result));
            uploadStream.end(req.file.buffer);
        });
        res.json({ url: result.secure_url });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const stockQuantity = req.body.stockQuantity || 0;
        const productData = {
            ...req.body,
            stockQuantity: stockQuantity,
            inStock: stockQuantity > 0,
            stockAlert: req.body.stockAlert || 5,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            avgRating: 0,
            reviewCount: 0
        };
        const docRef = await db.collection('products').add(productData);
        res.json({ id: docRef.id, ...productData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/products/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const updateData = { ...req.body, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        await db.collection('products').doc(req.params.id).update(updateData);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/products/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const reviewsSnapshot = await db.collection('reviews').where('productId', '==', req.params.id).get();
        const batch = db.batch();
        reviewsSnapshot.forEach(doc => batch.delete(doc.ref));
        batch.delete(db.collection('products').doc(req.params.id));
        await batch.commit();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ROUTES ADMIN CATÉGORIES ====================

app.post('/api/categories', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const docRef = await db.collection('categories').add({ ...req.body, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ id: docRef.id, ...req.body });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/categories/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        await db.collection('categories').doc(req.params.id).update(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/categories/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        await db.collection('categories').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ROUTES ADMIN ZONES ====================

app.post('/api/zones', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const zonesSnapshot = await db.collection('zones').get();
        const docRef = await db.collection('zones').add({ ...req.body, order: zonesSnapshot.size, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        res.json({ id: docRef.id, ...req.body });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/zones/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        await db.collection('zones').doc(req.params.id).update(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/zones/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        await db.collection('zones').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== COMMANDES ====================

app.post('/api/orders', verifyToken, async (req, res) => {
    try {
        const orderItems = req.body.items || [];
        
        for (const item of orderItems) {
            const productDoc = await db.collection('products').doc(item.productId).get();
            if (!productDoc.exists) {
                return res.status(400).json({ error: `Produit "${item.name}" introuvable` });
            }
            const product = productDoc.data();
            const currentStock = product.stockQuantity || 0;
            if (currentStock < item.qty) {
                return res.status(400).json({ error: `Stock insuffisant pour "${item.name}". Disponible: ${currentStock}` });
            }
        }
        
        const orderRef = db.collection('orders').doc();
        const orderId = orderRef.id;
        
        await db.runTransaction(async (transaction) => {
            for (const item of orderItems) {
                const productRef = db.collection('products').doc(item.productId);
                const productDoc = await transaction.get(productRef);
                const product = productDoc.data();
                const newStock = (product.stockQuantity || 0) - item.qty;
                transaction.update(productRef, {
                    stockQuantity: newStock,
                    inStock: newStock > 0,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
            const orderData = {
                id: orderId,
                ...req.body,
                userId: req.user.uid,
                userEmail: req.user.email,
                status: 'pending',
                orderNumber: `CMD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            transaction.set(orderRef, orderData);
        });
        
        const createdOrder = await orderRef.get();
        res.json({ success: true, id: orderId, ...createdOrder.data() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders/my', verifyToken, async (req, res) => {
    try {
        const snapshot = await db.collection('orders')
            .where('userId', '==', req.user.uid)
            .orderBy('createdAt', 'desc')
            .get();
        const orders = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            orders.push({ 
                id: doc.id, 
                ...data,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
            });
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        let query = db.collection('orders').orderBy('createdAt', 'desc');
        if (req.query.limit) query = query.limit(parseInt(req.query.limit));
        const snapshot = await query.get();
        const orders = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            orders.push({ 
                id: doc.id, 
                ...data,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
            });
        });
        res.json(orders);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/orders/:id/status', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        await db.collection('orders').doc(req.params.id).update({
            status: req.body.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/orders/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const orderDoc = await db.collection('orders').doc(req.params.id).get();
        const order = orderDoc.data();
        
        if (order && order.status !== 'delivered' && order.status !== 'cancelled') {
            for (const item of order.items) {
                const productRef = db.collection('products').doc(item.productId);
                const productDoc = await productRef.get();
                if (productDoc.exists) {
                    const currentStock = productDoc.data().stockQuantity || 0;
                    await productRef.update({
                        stockQuantity: currentStock + item.qty,
                        inStock: true,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }
        }
        
        await db.collection('orders').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== STATS ADMIN ====================

app.get('/api/admin/stats', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const ordersSnapshot = await db.collection('orders').get();
        let revenue = 0;
        ordersSnapshot.forEach(doc => {
            const order = doc.data();
            if (order.status !== 'cancelled') revenue += order.total || 0;
        });
        const usersSnapshot = await db.collection('users').get();
        const productsSnapshot = await db.collection('products').get();
        
        res.json({
            orderCount: ordersSnapshot.size,
            revenue: revenue,
            userCount: usersSnapshot.size,
            productCount: productsSnapshot.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== ROUTES UTILISATEURS ====================

app.get('/api/users', verifyToken, async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin requis' });
    try {
        const snapshot = await db.collection('users').get();
        const users = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            users.push({ id: doc.id, ...data, createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null });
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/me', verifyToken, async (req, res) => {
    try {
        const doc = await db.collection('users').doc(req.user.uid).get();
        if (!doc.exists) return res.status(404).json({ error: 'Utilisateur non trouvé' });
        const data = doc.data();
        res.json({ id: doc.id, ...data, createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/users', verifyToken, async (req, res) => {
    try {
        if (req.body.uid !== req.user.uid) return res.status(403).json({ error: 'UID invalide' });
        const existingUser = await db.collection('users').doc(req.body.uid).get();
        if (existingUser.exists) return res.json({ success: true });
        await db.collection('users').doc(req.body.uid).set({
            name: req.body.name, email: req.body.email, phone: req.body.phone,
            emailVerified: req.body.emailVerified || false, role: 'client',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Santé
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Serveur GoHBITO démarré sur port ${PORT}`);
});
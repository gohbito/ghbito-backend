const express = require('express');
const cors = require('cors');
const cloudinary = require('cloudinary').v2;
const admin = require('firebase-admin');
const multer = require('multer');
require('dotenv').config();

const app = express();

// ==================== CONFIGURATION CORS ====================
app.use(cors({
    origin: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000', 'http://127.0.0.1:3000', 'https://ventegohbito.netlify.app'],
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

// Route d'accueil
app.get('/', (req, res) => {
    res.json({ 
        message: '🚀 Serveur GHBITO en ligne !',
        endpoints: [
            'GET  /api/products',
            'GET  /api/categories',
            'GET  /api/zones',
            'POST /api/orders (stock auto-décrementé)'
        ]
    });
});

// 1. Récupérer tous les produits (public)
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
        console.error('Erreur GET /products:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Récupérer toutes les catégories (public)
app.get('/api/categories', async (req, res) => {
    try {
        const snapshot = await db.collection('categories').orderBy('name').get();
        const categories = [];
        snapshot.forEach(doc => {
            categories.push({ id: doc.id, ...doc.data() });
        });
        res.json(categories);
    } catch (error) {
        console.error('Erreur GET /categories:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Récupérer toutes les zones (public)
app.get('/api/zones', async (req, res) => {
    try {
        const snapshot = await db.collection('zones').orderBy('order').get();
        const zones = [];
        snapshot.forEach(doc => {
            zones.push({ id: doc.id, ...doc.data() });
        });
        res.json(zones);
    } catch (error) {
        console.error('Erreur GET /zones:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. Récupérer les avis d'un produit (public)
app.get('/api/products/:id/reviews', async (req, res) => {
    try {
        const snapshot = await db.collection('reviews')
            .where('productId', '==', req.params.id)
            .orderBy('createdAt', 'desc')
            .get();
        const reviews = [];
        snapshot.forEach(doc => {
            reviews.push({ id: doc.id, ...doc.data() });
        });
        res.json(reviews);
    } catch (error) {
        console.error('Erreur GET /products/:id/reviews:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. Ajouter un avis
app.post('/api/products/:id/reviews', verifyToken, async (req, res) => {
    try {
        const productId = req.params.id;
        const { rating, text } = req.body;
        
        // Vérifier si l'utilisateur a déjà acheté et reçu le produit
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
        
        // Vérifier si l'utilisateur a déjà laissé un avis
        const existingReview = await db.collection('reviews')
            .where('productId', '==', productId)
            .where('userId', '==', req.user.uid)
            .get();
        
        if (!existingReview.empty) {
            return res.status(400).json({ error: 'Vous avez déjà laissé un avis pour ce produit' });
        }
        
        // Récupérer les infos utilisateur
        const userDoc = await db.collection('users').doc(req.user.uid).get();
        const userName = userDoc.exists ? userDoc.data().name : req.user.email;
        
        // Créer l'avis
        const reviewData = {
            productId,
            userId: req.user.uid,
            userName: userName,
            rating: parseInt(rating),
            text: text,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        await db.collection('reviews').add(reviewData);
        
        // Mettre à jour la moyenne des notes du produit
        const allReviews = await db.collection('reviews')
            .where('productId', '==', productId)
            .get();
        
        let totalRating = 0;
        allReviews.forEach(doc => {
            totalRating += doc.data().rating;
        });
        
        const avgRating = totalRating / allReviews.size;
        const reviewCount = allReviews.size;
        
        await db.collection('products').doc(productId).update({
            avgRating: avgRating,
            reviewCount: reviewCount
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur POST /products/:id/reviews:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== ROUTES ADMIN ====================

// Upload image
app.post('/api/upload', verifyToken, upload.single('image'), async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    if (!req.file) {
        return res.status(400).json({ error: 'Aucune image' });
    }
    
    try {
        const result = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream({
                folder: 'ghbito/products',
                transformation: [{ width: 800, height: 800, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }]
            }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
            uploadStream.end(req.file.buffer);
        });
        
        res.json({ url: result.secure_url });
    } catch (error) {
        console.error('Erreur upload:', error);
        res.status(500).json({ error: error.message });
    }
});

// Créer un produit
app.post('/api/products', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
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
        console.error('Erreur POST /products:', error);
        res.status(500).json({ error: error.message });
    }
});

// Modifier un produit
app.put('/api/products/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const stockQuantity = req.body.stockQuantity;
        const updateData = {
            ...req.body,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // Mettre à jour inStock automatiquement
        if (stockQuantity !== undefined) {
            updateData.inStock = stockQuantity > 0;
        }
        
        await db.collection('products').doc(req.params.id).update(updateData);
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur PUT /products:', error);
        res.status(500).json({ error: error.message });
    }
});

// Supprimer un produit
app.delete('/api/products/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        // Supprimer également les avis associés
        const reviewsSnapshot = await db.collection('reviews')
            .where('productId', '==', req.params.id)
            .get();
        
        const batch = db.batch();
        reviewsSnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });
        batch.delete(db.collection('products').doc(req.params.id));
        await batch.commit();
        
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur DELETE /products:', error);
        res.status(500).json({ error: error.message });
    }
});

// Créer une catégorie
app.post('/api/categories', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const catData = {
            ...req.body,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const docRef = await db.collection('categories').add(catData);
        res.json({ id: docRef.id, ...catData });
    } catch (error) {
        console.error('Erreur POST /categories:', error);
        res.status(500).json({ error: error.message });
    }
});

// Modifier une catégorie
app.put('/api/categories/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        await db.collection('categories').doc(req.params.id).update(req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur PUT /categories:', error);
        res.status(500).json({ error: error.message });
    }
});

// Supprimer une catégorie
app.delete('/api/categories/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        await db.collection('categories').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur DELETE /categories:', error);
        res.status(500).json({ error: error.message });
    }
});

// Créer une zone
app.post('/api/zones', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const zoneData = {
            ...req.body,
            order: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };
        const docRef = await db.collection('zones').add(zoneData);
        res.json({ id: docRef.id, ...zoneData });
    } catch (error) {
        console.error('Erreur POST /zones:', error);
        res.status(500).json({ error: error.message });
    }
});

// Modifier une zone
app.put('/api/zones/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        await db.collection('zones').doc(req.params.id).update(req.body);
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur PUT /zones:', error);
        res.status(500).json({ error: error.message });
    }
});

// Supprimer une zone
app.delete('/api/zones/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        await db.collection('zones').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur DELETE /zones:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==================== COMMANDES AVEC DÉCRÉMENTATION STOCK ====================

// Créer une commande (avec décrémentation automatique du stock)
app.post('/api/orders', verifyToken, async (req, res) => {
    try {
        const orderItems = req.body.items || [];
        
        // Vérification du stock pour chaque produit
        for (const item of orderItems) {
            const productDoc = await db.collection('products').doc(item.productId).get();
            if (!productDoc.exists) {
                return res.status(400).json({ error: `Produit "${item.name}" introuvable` });
            }
            
            const product = productDoc.data();
            const currentStock = product.stockQuantity || 0;
            
            if (currentStock < item.qty) {
                return res.status(400).json({ 
                    error: `Stock insuffisant pour "${item.name}". Disponible: ${currentStock}` 
                });
            }
        }
        
        // Firestore transaction pour la décrémentation
        const orderRef = db.collection('orders').doc();
        const orderId = orderRef.id;
        
        await db.runTransaction(async (transaction) => {
            // Décrémenter le stock pour chaque produit
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
                
                // Alerte stock bas (log)
                if (newStock <= (product.stockAlert || 5) && newStock > 0) {
                    console.log(`⚠️ Stock bas pour "${product.name}": ${newStock} restants`);
                }
            }
            
            // Créer la commande
            const orderData = {
                id: orderId,
                ...req.body,
                userId: req.user.uid,
                status: 'pending',
                orderNumber: `CMD-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            
            transaction.set(orderRef, orderData);
        });
        
        // Récupérer la commande créée
        const createdOrder = await orderRef.get();
        
        res.json({ 
            success: true, 
            id: orderId,
            ...createdOrder.data() 
        });
    } catch (error) {
        console.error('Erreur POST /orders:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mes commandes
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
        console.error('Erreur GET /orders/my:', error);
        res.status(500).json({ error: error.message });
    }
});

// Toutes les commandes (admin)
app.get('/api/orders', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
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
        console.error('Erreur GET /orders:', error);
        res.status(500).json({ error: error.message });
    }
});

// Changer statut commande (admin)
app.patch('/api/orders/:id/status', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const newStatus = req.body.status;
        const updateData = {
            status: newStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        // Si la commande est annulée, on remet le stock
        if (newStatus === 'cancelled') {
            const orderDoc = await db.collection('orders').doc(req.params.id).get();
            const order = orderDoc.data();
            
            if (order && order.items) {
                for (const item of order.items) {
                    const productRef = db.collection('products').doc(item.productId);
                    const productDoc = await productRef.get();
                    const currentStock = productDoc.data().stockQuantity || 0;
                    
                    await productRef.update({
                        stockQuantity: currentStock + item.qty,
                        inStock: true,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                }
            }
        }
        
        await db.collection('orders').doc(req.params.id).update(updateData);
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur PATCH /orders/status:', error);
        res.status(500).json({ error: error.message });
    }
});

// Supprimer commande (admin)
app.delete('/api/orders/:id', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        // Récupérer la commande pour remettre le stock si nécessaire
        const orderDoc = await db.collection('orders').doc(req.params.id).get();
        const order = orderDoc.data();
        
        if (order && order.status !== 'cancelled' && order.status !== 'delivered') {
            for (const item of order.items) {
                const productRef = db.collection('products').doc(item.productId);
                const productDoc = await productRef.get();
                const currentStock = productDoc.data().stockQuantity || 0;
                
                await productRef.update({
                    stockQuantity: currentStock + item.qty,
                    inStock: true,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        }
        
        await db.collection('orders').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur DELETE /orders:', error);
        res.status(500).json({ error: error.message });
    }
});

// Stats admin
app.get('/api/admin/stats', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const ordersSnapshot = await db.collection('orders').get();
        let revenue = 0;
        ordersSnapshot.forEach(doc => {
            const order = doc.data();
            if (order.status !== 'cancelled') {
                revenue += order.total || 0;
            }
        });
        
        const usersSnapshot = await db.collection('users').get();
        
        res.json({
            orderCount: ordersSnapshot.size,
            revenue: revenue,
            userCount: usersSnapshot.size
        });
    } catch (error) {
        console.error('Erreur GET /admin/stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Tous les utilisateurs (admin)
app.get('/api/users', verifyToken, async (req, res) => {
    if (!req.isAdmin) {
        return res.status(403).json({ error: 'Admin requis' });
    }
    
    try {
        const snapshot = await db.collection('users').get();
        const users = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            users.push({ 
                id: doc.id, 
                ...data,
                createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
            });
        });
        res.json(users);
    } catch (error) {
        console.error('Erreur GET /users:', error);
        res.status(500).json({ error: error.message });
    }
});

// Mes infos utilisateur
app.get('/api/users/me', verifyToken, async (req, res) => {
    try {
        const doc = await db.collection('users').doc(req.user.uid).get();
        if (!doc.exists) {
            return res.status(404).json({ error: 'Utilisateur non trouvé' });
        }
        const data = doc.data();
        res.json({ 
            id: doc.id, 
            ...data,
            createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null
        });
    } catch (error) {
        console.error('Erreur GET /users/me:', error);
        res.status(500).json({ error: error.message });
    }
});

// Créer un utilisateur
app.post('/api/users', verifyToken, async (req, res) => {
    try {
        if (req.body.uid !== req.user.uid) {
            return res.status(403).json({ error: 'UID invalide' });
        }
        
        await db.collection('users').doc(req.body.uid).set({
            name: req.body.name,
            email: req.body.email,
            phone: req.body.phone,
            role: 'client',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur POST /users:', error);
        res.status(500).json({ error: error.message });
    }
});

// Démarrer le serveur
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});
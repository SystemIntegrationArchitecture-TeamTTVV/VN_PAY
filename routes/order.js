/**
 * VNPAY Payment Routes — Enhanced for Coin Purchase & BĐS transactions
 * 
 * Flow:
 * 1. FrontEnd calls MessageService → /billing/payment/create → gets orderCode + amountVnd
 * 2. FrontEnd calls THIS service → /order/create_coin_payment → gets VNPAY paymentUrl
 * 3. User pays on VNPAY
 * 4. VNPAY calls IPN → THIS service → /order/vnpay_coin_ipn → calls MessageService /billing/payment/vnpay-callback
 * 5. VNPAY redirects user → FrontEnd /wallet/vnpay-return?...
 */

let express = require('express');
let router = express.Router();
let $ = require('jquery');
const request = require('request');
const moment = require('moment');
const fetch = require('node-fetch');

// ─── Load Environment Variables from .env (Zero-dependency manual loader) ──
const fs = require('fs');
const path = require('path');
try {
    const envPath = path.join(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                const index = trimmed.indexOf('=');
                const key = trimmed.substring(0, index).trim();
                const val = trimmed.substring(index + 1).trim().replace(/^['"]|['"]$/g, '');
                if (key) {
                    process.env[key] = val;
                }
            }
        });
    }
} catch (err) {
    console.warn('[VNPAY] Warning: Failed to load .env manually:', err.message);
}

// ─── MediaService Base URL (BillingController lives in MediaService:8084) ───
const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL || 'https://api.websitedev.software/api/message';

router.get('/', function(req, res, next){
    res.render('orderlist', { title: 'Danh sách đơn hàng' })
});

router.get('/create_payment_url', function (req, res, next) {
    res.render('order', {title: 'Tạo mới đơn hàng', amount: 10000})
});

router.get('/querydr', function (req, res, next) {
    
    let desc = 'truy van ket qua thanh toan';
    res.render('querydr', {title: 'Truy vấn kết quả thanh toán'})
});

router.get('/refund', function (req, res, next) {
    
    let desc = 'Hoan tien GD thanh toan';
    res.render('refund', {title: 'Hoàn tiền giao dịch thanh toán'})
});


router.post('/create_payment_url', function (req, res, next) {
    
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    
    let date = new Date();
    let createDate = moment(date).format('YYYYMMDDHHmmss');
    
    let ipAddr = req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;

    let config = require('config');
    
    let tmnCode = config.get('vnp_TmnCode');
    let secretKey = config.get('vnp_HashSecret');
    let vnpUrl = config.get('vnp_Url');
    let returnUrl = config.get('vnp_ReturnUrl');
    let orderId = moment(date).format('DDHHmmss');
    let amount = req.body.amount;
    let bankCode = req.body.bankCode;
    
    let locale = req.body.language;
    if(locale === null || locale === ''){
        locale = 'vn';
    }
    let currCode = 'VND';
    let vnp_Params = {};
    vnp_Params['vnp_Version'] = '2.1.0';
    vnp_Params['vnp_Command'] = 'pay';
    vnp_Params['vnp_TmnCode'] = tmnCode;
    vnp_Params['vnp_Locale'] = locale;
    vnp_Params['vnp_CurrCode'] = currCode;
    vnp_Params['vnp_TxnRef'] = orderId;
    vnp_Params['vnp_OrderInfo'] = 'Thanh toan cho ma GD:' + orderId;
    vnp_Params['vnp_OrderType'] = 'other';
    vnp_Params['vnp_Amount'] = amount * 100;
    vnp_Params['vnp_ReturnUrl'] = returnUrl;
    vnp_Params['vnp_IpAddr'] = ipAddr;
    vnp_Params['vnp_CreateDate'] = createDate;
    if(bankCode !== null && bankCode !== ''){
        vnp_Params['vnp_BankCode'] = bankCode;
    }

    vnp_Params = sortObject(vnp_Params);

    let querystring = require('qs');
    let signData = querystring.stringify(vnp_Params, { encode: false });
    let crypto = require("crypto");     
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(new Buffer(signData, 'utf-8')).digest("hex"); 
    vnp_Params['vnp_SecureHash'] = signed;
    vnpUrl += '?' + querystring.stringify(vnp_Params, { encode: false });

    res.redirect(vnpUrl)
});

/**
 * Tạo URL thanh toán VNPay cho giao dịch BĐS (ERA Estate).
 * BE gọi endpoint này với transactionId, amount, returnUrl.
 * Trả về JSON { paymentUrl } thay vì redirect.
 */
router.post('/create_payment_for_transaction', function (req, res, next) {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    let date = new Date();
    let createDate = moment(date).format('YYYYMMDDHHmmss');
    let ipAddr = req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;
    let config = require('config');
    let tmnCode = config.get('vnp_TmnCode');
    let secretKey = config.get('vnp_HashSecret');
    let vnpUrlBase = config.get('vnp_Url');
    let defaultReturnUrl = config.get('vnp_ReturnUrl');

    let transactionId = req.body.transactionId;
    let amount = req.body.amount;
    let returnUrl = req.body.returnUrl || defaultReturnUrl;
    let bankCode = req.body.bankCode || '';

    if (!transactionId || amount == null) {
        return res.status(400).json({ error: 'transactionId and amount are required' });
    }
    let locale = req.body.language || 'vn';
    let vnp_Params = {};
    vnp_Params['vnp_Version'] = '2.1.0';
    vnp_Params['vnp_Command'] = 'pay';
    vnp_Params['vnp_TmnCode'] = tmnCode;
    vnp_Params['vnp_Locale'] = locale;
    vnp_Params['vnp_CurrCode'] = 'VND';
    vnp_Params['vnp_TxnRef'] = String(transactionId);
    vnp_Params['vnp_OrderInfo'] = 'Thanh toan giao dich BDS: ' + transactionId;
    vnp_Params['vnp_OrderType'] = 'other';
    vnp_Params['vnp_Amount'] = Math.round(Number(amount)) * 100;
    vnp_Params['vnp_ReturnUrl'] = returnUrl;
    vnp_Params['vnp_IpAddr'] = ipAddr || '127.0.0.1';
    vnp_Params['vnp_CreateDate'] = createDate;
    if (bankCode) {
        vnp_Params['vnp_BankCode'] = bankCode;
    }
    vnp_Params = sortObject(vnp_Params);
    let querystring = require('qs');
    let signData = querystring.stringify(vnp_Params, { encode: false });
    let crypto = require("crypto");
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(new Buffer(signData, 'utf-8')).digest("hex");
    vnp_Params['vnp_SecureHash'] = signed;
    let paymentUrl = vnpUrlBase + '?' + querystring.stringify(vnp_Params, { encode: false });
    res.json({ paymentUrl: paymentUrl });
});

// ══════════════════════════════════════════════════════════════════════════════
// ═══ COIN PURCHASE — VNPAY integration for Social Network coin top-up ═══════
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create VNPAY payment URL for coin purchase.
 * 
 * Request body:
 *   - orderCode: unique order code from MessageService (vnp_TxnRef)
 *   - amount: amount in VND (will be multiplied by 100 for VNPAY)
 *   - returnUrl: FrontEnd URL for VNPAY to redirect after payment
 *   - bankCode: (optional) specific bank
 * 
 * Returns: { paymentUrl: "https://sandbox.vnpayment.vn/..." }
 */
router.post('/create_coin_payment', function (req, res, next) {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    let date = new Date();
    let createDate = moment(date).format('YYYYMMDDHHmmss');
    let expireDate = moment(date).add(15, 'minutes').format('YYYYMMDDHHmmss');

    let ipAddr = req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        (req.connection.socket ? req.connection.socket.remoteAddress : '127.0.0.1');
        
    // Clean up IP Address for VNPAY (VNPAY prefers IPv4 and no comma separated values)
    if (ipAddr && ipAddr.indexOf(',') !== -1) {
        ipAddr = ipAddr.split(',')[0];
    }
    if (ipAddr === '::1' || ipAddr === '::ffff:127.0.0.1') {
        ipAddr = '127.0.0.1';
    }

    let config = require('config');
    let tmnCode = config.get('vnp_TmnCode');
    let secretKey = config.get('vnp_HashSecret');
    let vnpUrlBase = config.get('vnp_Url');

    let orderCode = req.body.orderCode;
    let amount = req.body.amount;
    let returnUrl = req.body.returnUrl;
    let bankCode = req.body.bankCode || '';

    if (!orderCode || amount == null || !returnUrl) {
        return res.status(400).json({
            error: 'orderCode, amount, and returnUrl are required'
        });
    }

    // Validate amount
    let amountNum = Math.round(Number(amount));
    if (isNaN(amountNum) || amountNum <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }

    let vnp_Params = {};
    vnp_Params['vnp_Version'] = '2.1.0';
    vnp_Params['vnp_Command'] = 'pay';
    vnp_Params['vnp_TmnCode'] = tmnCode;
    vnp_Params['vnp_Locale'] = 'vn';
    vnp_Params['vnp_CurrCode'] = 'VND';
    vnp_Params['vnp_TxnRef'] = String(orderCode);
    vnp_Params['vnp_OrderInfo'] = 'NapXuTTVV_' + orderCode;
    vnp_Params['vnp_OrderType'] = 'other';
    vnp_Params['vnp_Amount'] = amountNum * 100;
    vnp_Params['vnp_ReturnUrl'] = returnUrl;
    vnp_Params['vnp_IpAddr'] = ipAddr || '127.0.0.1';
    vnp_Params['vnp_CreateDate'] = createDate;
    vnp_Params['vnp_ExpireDate'] = expireDate;

    if (bankCode) {
        vnp_Params['vnp_BankCode'] = bankCode;
    }

    vnp_Params = sortObject(vnp_Params);

    let querystring = require('qs');
    let signData = querystring.stringify(vnp_Params, { encode: false });
    let crypto = require("crypto");
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(new Buffer(signData, 'utf-8')).digest("hex");
    vnp_Params['vnp_SecureHash'] = signed;

    let paymentUrl = vnpUrlBase + '?' + querystring.stringify(vnp_Params, { encode: false });

    console.log(`[COIN] Created VNPAY URL for orderCode=${orderCode}, amount=${amountNum} VND`);
    res.json({ paymentUrl: paymentUrl });
});

/**
 * VNPAY IPN callback for coin purchases.
 * VNPAY calls this endpoint to confirm payment result.
 * We verify the signature, then notify MessageService to credit coins.
 */
router.get('/vnpay_coin_ipn', async function (req, res, next) {
    let vnp_Params = req.query;
    let secureHash = vnp_Params['vnp_SecureHash'];

    let orderCode = vnp_Params['vnp_TxnRef'];
    let rspCode = vnp_Params['vnp_ResponseCode'];

    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    vnp_Params = sortObject(vnp_Params);
    let config = require('config');
    let secretKey = config.get('vnp_HashSecret');
    let querystring = require('qs');
    let signData = querystring.stringify(vnp_Params, { encode: false });
    let crypto = require("crypto");
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(new Buffer(signData, 'utf-8')).digest("hex");

    if (secureHash !== signed) {
        console.log(`[COIN IPN] ❌ Checksum failed for orderCode=${orderCode}`);
        return res.status(200).json({ RspCode: '97', Message: 'Checksum failed' });
    }

    console.log(`[COIN IPN] ✅ Valid signature for orderCode=${orderCode}, responseCode=${rspCode}`);

    // Notify MessageService to process the payment
    try {
        const callbackData = {
            orderCode: orderCode,
            vnpResponseCode: rspCode,
            vnpTransactionNo: vnp_Params['vnp_TransactionNo'] || '',
            vnpBankCode: vnp_Params['vnp_BankCode'] || '',
            vnpCardType: vnp_Params['vnp_CardType'] || '',
            vnpPayDate: vnp_Params['vnp_PayDate'] || '',
        };

        const response = await fetch(`${MEDIA_SERVICE_URL}/billing/payment/vnpay-callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(callbackData),
        });

        if (response.ok) {
            console.log(`[COIN IPN] ✅ MessageService callback success for orderCode=${orderCode}`);
            res.status(200).json({ RspCode: '00', Message: 'Success' });
        } else {
            const errText = await response.text();
            console.log(`[COIN IPN] ⚠️ MessageService callback failed: ${errText}`);
            res.status(200).json({ RspCode: '00', Message: 'Success' }); // Still respond OK to VNPAY
        }
    } catch (error) {
        console.error(`[COIN IPN] ❌ Failed to call MessageService:`, error.message);
        res.status(200).json({ RspCode: '99', Message: 'Internal error' });
    }
});

/**
 * VNPAY return URL handler for coin purchases.
 * Verifies the signature and returns payment result as JSON.
 * Frontend calls this to verify payment on return.
 */
router.get('/vnpay_coin_return', async function (req, res, next) {
    let vnp_Params = req.query;
    let secureHash = vnp_Params['vnp_SecureHash'];

    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    vnp_Params = sortObject(vnp_Params);

    let config = require('config');
    let secretKey = config.get('vnp_HashSecret');
    let querystring = require('qs');
    let signData = querystring.stringify(vnp_Params, { encode: false });
    let crypto = require("crypto");
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(new Buffer(signData, 'utf-8')).digest("hex");

    let result = {
        orderCode: vnp_Params['vnp_TxnRef'],
        responseCode: vnp_Params['vnp_ResponseCode'],
        transactionNo: vnp_Params['vnp_TransactionNo'] || '',
        bankCode: vnp_Params['vnp_BankCode'] || '',
        amount: vnp_Params['vnp_Amount'] ? parseInt(vnp_Params['vnp_Amount']) / 100 : 0,
        payDate: vnp_Params['vnp_PayDate'] || '',
        isValid: secureHash === signed,
        isSuccess: secureHash === signed && vnp_Params['vnp_ResponseCode'] === '00',
    };

    // Also notify MessageService (in case IPN hasn't arrived yet)
    if (result.isValid) {
        try {
            const callbackData = {
                orderCode: result.orderCode,
                vnpResponseCode: vnp_Params['vnp_ResponseCode'],
                vnpTransactionNo: result.transactionNo,
                vnpBankCode: result.bankCode,
                vnpCardType: vnp_Params['vnp_CardType'] || '',
                vnpPayDate: result.payDate,
            };

            const response = await fetch(`${MEDIA_SERVICE_URL}/billing/payment/vnpay-callback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(callbackData),
            });
            if (!response.ok) {
                const errText = await response.text();
                console.error(`[COIN RETURN] ⚠️ MessageService callback failed with status ${response.status}: ${errText}`);
            } else {
                console.log(`[COIN RETURN] ✅ MessageService callback success for orderCode=${result.orderCode}`);
            }
        } catch (err) {
            console.error('[COIN RETURN] Warning: Failed to notify MessageService:', err.message);
        }
    }

    res.json(result);
});


// ─── Original VNPAY routes ──────────────────────────────────────────────────

router.get('/vnpay_return', function (req, res, next) {
    let vnp_Params = req.query;

    let secureHash = vnp_Params['vnp_SecureHash'];

    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    vnp_Params = sortObject(vnp_Params);

    let config = require('config');
    let tmnCode = config.get('vnp_TmnCode');
    let secretKey = config.get('vnp_HashSecret');

    let querystring = require('qs');
    let signData = querystring.stringify(vnp_Params, { encode: false });
    let crypto = require("crypto");     
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(new Buffer(signData, 'utf-8')).digest("hex");     

    if(secureHash === signed){
        //Kiem tra xem du lieu trong db co hop le hay khong va thong bao ket qua

        res.render('success', {code: vnp_Params['vnp_ResponseCode']})
    } else{
        res.render('success', {code: '97'})
    }
});

router.get('/vnpay_ipn', function (req, res, next) {
    let vnp_Params = req.query;
    let secureHash = vnp_Params['vnp_SecureHash'];
    
    let orderId = vnp_Params['vnp_TxnRef'];
    let rspCode = vnp_Params['vnp_ResponseCode'];

    delete vnp_Params['vnp_SecureHash'];
    delete vnp_Params['vnp_SecureHashType'];

    vnp_Params = sortObject(vnp_Params);
    let config = require('config');
    let secretKey = config.get('vnp_HashSecret');
    let querystring = require('qs');
    let signData = querystring.stringify(vnp_Params, { encode: false });
    let crypto = require("crypto");     
    let hmac = crypto.createHmac("sha512", secretKey);
    let signed = hmac.update(new Buffer(signData, 'utf-8')).digest("hex");     
    
    let paymentStatus = '0'; // Giả sử '0' là trạng thái khởi tạo giao dịch, chưa có IPN. Trạng thái này được lưu khi yêu cầu thanh toán chuyển hướng sang Cổng thanh toán VNPAY tại đầu khởi tạo đơn hàng.
    //let paymentStatus = '1'; // Giả sử '1' là trạng thái thành công bạn cập nhật sau IPN được gọi và trả kết quả về nó
    //let paymentStatus = '2'; // Giả sử '2' là trạng thái thất bại bạn cập nhật sau IPN được gọi và trả kết quả về nó
    
    let checkOrderId = true; // Mã đơn hàng "giá trị của vnp_TxnRef" VNPAY phản hồi tồn tại trong CSDL của bạn
    let checkAmount = true; // Kiểm tra số tiền "giá trị của vnp_Amout/100" trùng khớp với số tiền của đơn hàng trong CSDL của bạn
    if(secureHash === signed){ //kiểm tra checksum
        if(checkOrderId){
            if(checkAmount){
                if(paymentStatus=="0"){ //kiểm tra tình trạng giao dịch trước khi cập nhật tình trạng thanh toán
                    if(rspCode=="00"){
                        //thanh cong
                        //paymentStatus = '1'
                        // Ở đây cập nhật trạng thái giao dịch thanh toán thành công vào CSDL của bạn
                        res.status(200).json({RspCode: '00', Message: 'Success'})
                    }
                    else {
                        //that bai
                        //paymentStatus = '2'
                        // Ở đây cập nhật trạng thái giao dịch thanh toán thất bại vào CSDL của bạn
                        res.status(200).json({RspCode: '00', Message: 'Success'})
                    }
                }
                else{
                    res.status(200).json({RspCode: '02', Message: 'This order has been updated to the payment status'})
                }
            }
            else{
                res.status(200).json({RspCode: '04', Message: 'Amount invalid'})
            }
        }       
        else {
            res.status(200).json({RspCode: '01', Message: 'Order not found'})
        }
    }
    else {
        res.status(200).json({RspCode: '97', Message: 'Checksum failed'})
    }
});

router.post('/querydr', function (req, res, next) {
    
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    let date = new Date();

    let config = require('config');
    let crypto = require("crypto");
    
    let vnp_TmnCode = config.get('vnp_TmnCode');
    let secretKey = config.get('vnp_HashSecret');
    let vnp_Api = config.get('vnp_Api');
    
    let vnp_TxnRef = req.body.orderId;
    let vnp_TransactionDate = req.body.transDate;
    
    let vnp_RequestId =moment(date).format('HHmmss');
    let vnp_Version = '2.1.0';
    let vnp_Command = 'querydr';
    let vnp_OrderInfo = 'Truy van GD ma:' + vnp_TxnRef;
    
    let vnp_IpAddr = req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;

    let currCode = 'VND';
    let vnp_CreateDate = moment(date).format('YYYYMMDDHHmmss');
    
    let data = vnp_RequestId + "|" + vnp_Version + "|" + vnp_Command + "|" + vnp_TmnCode + "|" + vnp_TxnRef + "|" + vnp_TransactionDate + "|" + vnp_CreateDate + "|" + vnp_IpAddr + "|" + vnp_OrderInfo;
    
    let hmac = crypto.createHmac("sha512", secretKey);
    let vnp_SecureHash = hmac.update(new Buffer(data, 'utf-8')).digest("hex"); 
    
    let dataObj = {
        'vnp_RequestId': vnp_RequestId,
        'vnp_Version': vnp_Version,
        'vnp_Command': vnp_Command,
        'vnp_TmnCode': vnp_TmnCode,
        'vnp_TxnRef': vnp_TxnRef,
        'vnp_OrderInfo': vnp_OrderInfo,
        'vnp_TransactionDate': vnp_TransactionDate,
        'vnp_CreateDate': vnp_CreateDate,
        'vnp_IpAddr': vnp_IpAddr,
        'vnp_SecureHash': vnp_SecureHash
    };
    // /merchant_webapi/api/transaction
    request({
        url: vnp_Api,
        method: "POST",
        json: true,   
        body: dataObj
            }, function (error, response, body){
                console.log(response);
            });

});

router.post('/refund', function (req, res, next) {
    
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    let date = new Date();

    let config = require('config');
    let crypto = require("crypto");
   
    let vnp_TmnCode = config.get('vnp_TmnCode');
    let secretKey = config.get('vnp_HashSecret');
    let vnp_Api = config.get('vnp_Api');
    
    let vnp_TxnRef = req.body.orderId;
    let vnp_TransactionDate = req.body.transDate;
    let vnp_Amount = req.body.amount *100;
    let vnp_TransactionType = req.body.transType;
    let vnp_CreateBy = req.body.user;
            
    let currCode = 'VND';
    
    let vnp_RequestId = moment(date).format('HHmmss');
    let vnp_Version = '2.1.0';
    let vnp_Command = 'refund';
    let vnp_OrderInfo = 'Hoan tien GD ma:' + vnp_TxnRef;
            
    let vnp_IpAddr = req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        req.socket.remoteAddress ||
        req.connection.socket.remoteAddress;

    
    let vnp_CreateDate = moment(date).format('YYYYMMDDHHmmss');
    
    let vnp_TransactionNo = '0';
    
    let data = vnp_RequestId + "|" + vnp_Version + "|" + vnp_Command + "|" + vnp_TmnCode + "|" + vnp_TransactionType + "|" + vnp_TxnRef + "|" + vnp_Amount + "|" + vnp_TransactionNo + "|" + vnp_TransactionDate + "|" + vnp_CreateBy + "|" + vnp_CreateDate + "|" + vnp_IpAddr + "|" + vnp_OrderInfo;
    let hmac = crypto.createHmac("sha512", secretKey);
    let vnp_SecureHash = hmac.update(new Buffer(data, 'utf-8')).digest("hex");
    
     let dataObj = {
        'vnp_RequestId': vnp_RequestId,
        'vnp_Version': vnp_Version,
        'vnp_Command': vnp_Command,
        'vnp_TmnCode': vnp_TmnCode,
        'vnp_TransactionType': vnp_TransactionType,
        'vnp_TxnRef': vnp_TxnRef,
        'vnp_Amount': vnp_Amount,
        'vnp_TransactionNo': vnp_TransactionNo,
        'vnp_CreateBy': vnp_CreateBy,
        'vnp_OrderInfo': vnp_OrderInfo,
        'vnp_TransactionDate': vnp_TransactionDate,
        'vnp_CreateDate': vnp_CreateDate,
        'vnp_IpAddr': vnp_IpAddr,
        'vnp_SecureHash': vnp_SecureHash
    };
    
    request({
        url: vnp_Api,
        method: "POST",
        json: true,   
        body: dataObj
            }, function (error, response, body){
                console.log(response);
            });
    
});

function sortObject(obj) {
	let sorted = {};
	let str = [];
	let key;
	for (key in obj){
		if (obj.hasOwnProperty(key)) {
		str.push(encodeURIComponent(key));
		}
	}
	str.sort();
    for (key = 0; key < str.length; key++) {
        sorted[str[key]] = encodeURIComponent(obj[str[key]]).replace(/%20/g, "+");
    }
    return sorted;
}

module.exports = router;
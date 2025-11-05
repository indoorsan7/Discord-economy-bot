require('dotenv').config();

const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    PermissionsBitField,
    EmbedBuilder,
    ChannelType
} = require('discord.js');
const axios = require('axios');
const express = require('express');

// 環境変数から設定を取得
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const ARASHI_CHANNEL_ID = process.env.ARASHI_CHANNEL_ID;
const PORT = process.env.PORT || 8000; 

// --- 経済システム (インメモリデータストア) ---
// Firestoreを使用するため、このインメモリマップは現在使用していません。
// const userBalance = new Map();
const userCooldowns = new Map();

// クールタイム定義 (ミリ秒)
const COOLDOWN_WORK_MS = 60 * 60 * 1000;      // 1時間
const COOLDOWN_ROB_MS = 30 * 60 * 1000;      // 30分
const COOLDOWN_TICKET_MS = 60 * 60 * 1000;   // 1時間
const COOLDOWN_ARASHI_MS = 60 * 60 * 1000;   // 1時間

const ROLE_ADD_COST = 10000;

/*
// インメモリ関数はFirestore使用に伴い非推奨
function getBalance(userId) {
    return userBalance.get(userId) || 0;
}

function updateBalance(userId, newBalance) {
    userBalance.set(userId, Math.max(0, newBalance)); // 残高が0未満にならないように
}
*/

function setCooldown(userId, command, durationMs) {
    userCooldowns.set(`${userId}-${command}`, Date.now() + durationMs);
}

function getCooldown(userId, command) {
    const cooldownTime = userCooldowns.get(`${userId}-${command}`);
    if (!cooldownTime) return 0;
    
    const remaining = cooldownTime - Date.now();
    if (remaining <= 0) {
        userCooldowns.delete(`${userId}-${command}`);
        return 0;
    }
    return remaining;
}

function msToTime(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);

    const parts = [];
    if (hours > 0) parts.push(`${hours}時間`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join('');
}

// --- Discord クライアントと認証 ---

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

// Firebase Admin SDK の初期化
const admin = require('firebase-admin');

// 環境変数からサービスアカウントJSONを読み込み、JSON.parse()でオブジェクトに変換
try {
    const serviceAccountJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccountJson),
        // データベースURLはFirestoreのみを使用する場合は不要ですが、念のため
        databaseURL: `https://${serviceAccountJson.project_id}.firebaseio.com`
    });

    console.log("Firebase Admin SDK initialized successfully.");
} catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error.message);
    // process.exit(1); // 致命的なエラーのため、終了させることも検討
}

const db = admin.firestore();


// --- スラッシュコマンドの定義 ---

const commands = [
    new SlashCommandBuilder()
        .setName('balance')
        .setDescription('現在のコイン残高を確認します。')
        .addUserOption(option => 
            option.setName('user')
                .setDescription('残高を確認したいユーザー')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('work')
        .setDescription('仕事をしてコインを稼ぎます。'),

    new SlashCommandBuilder()
        .setName('rob')
        .setDescription('他のユーザーからコインを奪おうとします。')
        .addUserOption(option => 
            option.setName('target')
                .setDescription('コインを奪う対象のユーザー')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('send')
        .setDescription('他のユーザーにコインを送金します。')
        .addUserOption(option => 
            option.setName('target')
                .setDescription('送金先のユーザー')
                .setRequired(true))
        .addIntegerOption(option => 
            option.setName('amount')
                .setDescription('送金するコインの量')
                .setRequired(true)
                .setMinValue(1)),

    new SlashCommandBuilder()
        .setName('register')
        .setDescription('Discordと連携してユーザーを登録します。'),

    new SlashCommandBuilder()
        .setName('roleadd')
        .setDescription(`**${ROLE_ADD_COST.toLocaleString()}** コインを消費してサーバー内の役職を付与します。`)
        .addStringOption(option =>
            option.setName('role_name')
                .setDescription('付与したい役職の名前')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('arashi')
        .setDescription('コインを賭けて一攫千金を狙います。'),

].map(command => command.toJSON());


// --- コマンドの登録 ---

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        // グローバルコマンドとして登録する場合
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );

        // 特定のギルド（サーバー）に登録する場合
        // await rest.put(
        //     Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        //     { body: commands },
        // );

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

// --- ユーティリティ関数 ---

function errorEmbed(description) {
    return new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('❌ エラー')
        .setDescription(description);
}

function successEmbed(title, description) {
    return new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle(title)
        .setDescription(description);
}


// --- 経済コマンドの実装 ---

// Firestoneからデータを取得
async function getFirestoreBalance(userId) {
    try {
        const userRef = db.collection('user_balances').doc(userId);
        const doc = await userRef.get();
        if (doc.exists) {
            const data = doc.data();
            return data.balance || 0;
        } else {
            // ドキュメントが存在しない場合は新規作成し、残高0を返す
            await userRef.set({ balance: 0, discordId: userId, verified: false });
            return 0;
        }
    } catch (error) {
        console.error(`Firestoreデータの取得/初期化エラー for ${userId}:`, error);
        return 0; // エラー発生時も0を返す
    }
}

// Firestoneにデータを更新
async function updateFirestoreBalance(userId, newBalance) {
    try {
        const userRef = db.collection('user_balances').doc(userId);
        await userRef.update({ balance: newBalance });
    } catch (error) {
        console.error(`Firestoreデータの更新エラー for ${userId}:`, error);
    }
}

// Balanceコマンド
async function handleBalance(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const balance = await getFirestoreBalance(targetUser.id);

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('💰 コイン残高')
        .setDescription(`${targetUser.username} の現在の残高は **${balance.toLocaleString()}** コインです。`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}


// Workコマンド
async function handleWork(interaction) {
    const userId = interaction.user.id;
    const command = 'work';
    const cooldown = getCooldown(userId, command);

    if (cooldown > 0) {
        return interaction.reply({ embeds: [errorEmbed(`まだ仕事ができません。残り: ${msToTime(cooldown)}`)], ephemeral: true });
    }

    const currentBalance = await getFirestoreBalance(userId);
    const amount = Math.floor(Math.random() * 500) + 100; // 100～599コイン

    const newBalance = currentBalance + amount;
    await updateFirestoreBalance(userId, newBalance);
    setCooldown(userId, command, COOLDOWN_WORK_MS);

    const embed = successEmbed('💼 仕事完了', `一生懸命働いた結果、**${amount.toLocaleString()}** コインを獲得しました。`)
        .addFields({ name: '現在の残高', value: `${newBalance.toLocaleString()} コイン`, inline: true })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// Robコマンド
async function handleRob(interaction) {
    const userId = interaction.user.id;
    const targetUser = interaction.options.getUser('target');
    const command = 'rob';
    const cooldown = getCooldown(userId, command);

    if (cooldown > 0) {
        return interaction.reply({ embeds: [errorEmbed(`まだ強盗に挑戦できません。残り: ${msToTime(cooldown)}`)], ephemeral: true });
    }

    if (targetUser.id === userId) {
        return interaction.reply({ embeds: [errorEmbed('自分自身を強盗することはできません。')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('ボットを強盗することはできません。')], ephemeral: true });
    }
    
    const targetBalance = await getFirestoreBalance(targetUser.id);
    if (targetBalance < 1000) {
        return interaction.reply({ embeds: [errorEmbed(`${targetUser.username} は貧しすぎます。残高が **1,000** コイン未満のユーザーは襲撃できません。`)], ephemeral: true });
    }

    setCooldown(userId, command, COOLDOWN_ROB_MS);

    const success = Math.random() < 0.3; // 30%の成功率
    
    if (success) {
        const stolenAmount = Math.floor(targetBalance * (Math.random() * 0.15 + 0.05)); // 5%～20%を奪う
        
        const currentBalance = await getFirestoreBalance(userId);
        
        const newTargetBalance = targetBalance - stolenAmount;
        const newOwnerBalance = currentBalance + stolenAmount;

        await updateFirestoreBalance(userId, newOwnerBalance);
        await updateFirestoreBalance(targetUser.id, newTargetBalance);

        const embed = successEmbed('🔪 強盗成功', `${targetUser.username} から **${stolenAmount.toLocaleString()}** コインを奪うことに成功しました！`)
            .addFields(
                { name: 'あなたの残高', value: `${newOwnerBalance.toLocaleString()} コイン`, inline: true },
                { name: `${targetUser.username}の残高`, value: `${newTargetBalance.toLocaleString()} コイン`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } else {
        const embed = errorEmbed('🚨 強盗失敗')
            .setDescription(`強盗に失敗しました。${targetUser.username} に気づかれて逃げられました。`)
            .setTimestamp();
            
        await interaction.reply({ embeds: [embed] });
    }
}

// Sendコマンド
async function handleSend(interaction) {
    const userId = interaction.user.id;
    const targetUser = interaction.options.getUser('target');
    const amount = interaction.options.getInteger('amount');

    if (targetUser.id === userId) {
        return interaction.reply({ embeds: [errorEmbed('自分自身に送金することはできません。')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('ボットに送金することはできません。')], ephemeral: true });
    }
    if (amount <= 0) {
        return interaction.reply({ embeds: [errorEmbed('送金するコインの量は1以上である必要があります。')], ephemeral: true });
    }

    const currentBalance = await getFirestoreBalance(userId);

    if (currentBalance < amount) {
        return interaction.reply({ 
            embeds: [errorEmbed(`送金に必要な **${amount.toLocaleString()}** コインが足りません。`)
                .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], 
            ephemeral: true 
        });
    }

    const targetBalance = await getFirestoreBalance(targetUser.id);
    
    const newSenderBalance = currentBalance - amount;
    const newReceiverBalance = targetBalance + amount;

    await updateFirestoreBalance(userId, newSenderBalance);
    await updateFirestoreBalance(targetUser.id, newReceiverBalance);

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💰 コイン送金完了')
        .setDescription(`**${amount.toLocaleString()}** コインを ${targetUser.username} に送金しました。`) 
        .addFields(
            { name: 'あなたの残高 (送金後)', value: `${newSenderBalance.toLocaleString()} コイン`, inline: true },
            { name: `${targetUser.username}の残高 (受領後)`, value: `${newReceiverBalance.toLocaleString()} コイン`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}


// Registerコマンド
async function handleRegister(interaction) {
    // 連携処理の実装 (ここでは省略し、登録完了メッセージのみ)
    const userId = interaction.user.id;
    await getFirestoreBalance(userId); // ユーザーのドキュメントをFirestoreに作成

    const embed = successEmbed('✅ ユーザー登録完了', 'あなたのDiscordアカウントは経済システムに登録されました。')
        .setFooter({ text: 'OAuth2連携を実装することで、よりセキュアな認証が可能になります。' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

// RoleAddコマンド
async function handleRoleAdd(interaction) {
    const userId = interaction.user.id;
    const roleName = interaction.options.getString('role_name');
    const cost = ROLE_ADD_COST;
    const currentBalance = await getFirestoreBalance(userId);

    // 役職の検索 (大文字小文字を区別せず部分一致で検索)
    const role = interaction.guild.roles.cache.find(r => r.name.toLowerCase().includes(roleName.toLowerCase()));

    if (!role) {
        return interaction.reply({ embeds: [errorEmbed(`役職「${roleName}」が見つかりませんでした。正確な役職名を入力してください。`)], ephemeral: true });
    }

    if (currentBalance < cost) {
        return interaction.reply({ 
            embeds: [errorEmbed(`役職「${role.name}」の付与に必要な **${cost.toLocaleString()}** コインが足りません。`)
                .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], 
            ephemeral: true 
        });
    }

    const member = interaction.member;
    if (member.roles.cache.has(role.id)) {
        return interaction.reply({ embeds: [errorEmbed(`あなたは既に役職「${role.name}」を持っています。`)], ephemeral: true });
    }

    try {
        await member.roles.add(role);
        
        const newBalance = currentBalance - cost;
        await updateFirestoreBalance(userId, newBalance);

        const embed = successEmbed('👑 役職付与完了', `**${cost.toLocaleString()}** コインを消費して役職 **${role.name}** が付与されました。`)
            .addFields({ name: '残高 (消費後)', value: `${newBalance.toLocaleString()} コイン`, inline: true })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });

    } catch (error) {
        console.error('役職付与エラー:', error);
        return interaction.reply({ embeds: [errorEmbed('役職の付与中にエラーが発生しました。ボットの権限を確認してください。')], ephemeral: true });
    }
}

// Arashiコマンド
async function handleArashi(interaction) {
    const userId = interaction.user.id;
    const command = 'arashi';
    const cooldown = getCooldown(userId, command);

    if (cooldown > 0) {
        return interaction.reply({ embeds: [errorEmbed(`次の「arashi」のチャンスまで待機が必要です。残り: ${msToTime(cooldown)}`)], ephemeral: true });
    }

    const currentBalance = await getFirestoreBalance(userId);
    const BET_AMOUNT = 1000;
    
    if (currentBalance < BET_AMOUNT) {
        return interaction.reply({ embeds: [errorEmbed(`「arashi」には最低 **${BET_AMOUNT.toLocaleString()}** コインが必要です。`)
            .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], ephemeral: true });
    }

    setCooldown(userId, command, COOLDOWN_ARASHI_MS);
    
    // 乱数生成と結果判定
    const result = Math.random();
    let winAmount = 0;
    let message = '';
    let color = 0xFF0000; // 敗北
    
    if (result < 0.05) { // 5%の確率で大勝利 (5倍)
        winAmount = BET_AMOUNT * 5;
        message = `🎊 激レア大当たり！**${winAmount.toLocaleString()}** コインを獲得！`;
        color = 0xFFFF00;
    } else if (result < 0.35) { // 30%の確率で小勝利 (1.5倍)
        winAmount = Math.floor(BET_AMOUNT * 1.5);
        message = `🎉 小当たり！**${winAmount.toLocaleString()}** コインを獲得しました。`;
        color = 0x00FF00;
    } else { // 65%の確率で失敗 (没収)
        winAmount = 0;
        message = `😭 失敗。賭け金 **${BET_AMOUNT.toLocaleString()}** コインは没収されました...。`;
    }
    
    const finalChange = winAmount - BET_AMOUNT;
    const newBalance = currentBalance + finalChange;
    await updateFirestoreBalance(userId, newBalance);

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('⚡️ コインの嵐 (arashi)')
        .setDescription(message)
        .addFields(
            { name: '賭け金', value: `${BET_AMOUNT.toLocaleString()} コイン`, inline: true },
            { name: '増減', value: `${finalChange > 0 ? '+' : ''}${finalChange.toLocaleString()} コイン`, inline: true },
            { name: '新しい残高', value: `${newBalance.toLocaleString()} コイン`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}


// --- Discordイベントリスナー ---

client.once('ready', () => {
    console.log(`Ready! Logged in as ${client.user.tag}`);
    // console.log(`Invite link: https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    try {
        switch (interaction.commandName) {
            case 'balance':
                await handleBalance(interaction);
                break;
            case 'work':
                await handleWork(interaction);
                break;
            case 'rob':
                await handleRob(interaction);
                break;
            case 'send':
                await handleSend(interaction);
                break;
            case 'register':
                await handleRegister(interaction);
                break;
            case 'roleadd':
                await handleRoleAdd(interaction);
                break;
            case 'arashi':
                await handleArashi(interaction);
                break;
            default:
                await interaction.reply({ embeds: [errorEmbed('未知のコマンドです。')], ephemeral: true });
        }
    } catch (error) {
        console.error(`コマンド実行中にエラーが発生しました (${interaction.commandName}):`, error);
        await interaction.reply({ embeds: [errorEmbed('コマンドの実行中にエラーが発生しました。時間をおいて再度お試しください。')], ephemeral: true }).catch(() => {});
    }
});

// --- ボットとサーバーの起動 ---

const app = express();

// Discord OAuth2 認証の実装
const OAUTH2_CLIENT_SECRET = process.env.OAUTH2_CLIENT_SECRET;
const OAUTH2_REDIRECT_URI = process.env.OAUTH2_REDIRECT_URI;

// ルートエンドポイント
app.get('/', (req, res) => {
    res.send('Discord Bot Web Server is running.');
});

// Discordの認証ページにリダイレクトするエンドポイント
app.get('/login', (req, res) => {
    const scope = encodeURIComponent('identify');
    const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${OAUTH2_REDIRECT_URI}&scope=${scope}`;
    res.redirect(url);
});

// Discordからのコールバックを受け取るエンドポイント
app.get('/verify', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('認証コードがありません。');
    }

    try {
        // 1. トークンを取得
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: OAUTH2_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: OAUTH2_REDIRECT_URI,
            scope: 'identify',
        }).toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const accessToken = tokenResponse.data.access_token;

        // 2. ユーザー情報を取得
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: {
                authorization: `Bearer ${accessToken}`,
            },
        });

        const discordUser = userResponse.data;
        const discordId = discordUser.id;

        // 3. Firestoreに検証済みフラグを設定
        const userRef = db.collection('user_balances').doc(discordId);
        await userRef.set({ verified: true, discordId: discordId }, { merge: true });

        res.send(`認証が完了しました！Discord ID: **${discordId}** は検証済みとして設定されました。`);

    } catch (error) {
        console.error('OAuth2認証エラー:', error.response ? error.response.data : error.message);
        res.status(500).send('認証中にエラーが発生しました。ログを確認してください。');
    }
});


client.login(TOKEN);

// Expressサーバーを起動
app.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}`);
});

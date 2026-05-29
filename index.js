const {
    Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder,
    ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
    PermissionFlagsBits, ChannelType, REST, Routes, SlashCommandBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const path = require('path');
require('dotenv').config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const ADMIN_USER_IDS       = config.adminUserIds       || [];
const MOD_ROLE_ID          = config.modRoleId          || '1509827018513186866';
const ADMIN_ROLE_ID        = config.adminRoleId        || '1509827044345774111';
const BUY_PING_ROLE_ID     = config.buyPingRoleId      || '1509826896756736000';
const SUPPORT_CATEGORY_ID  = config.supportCategoryId  || '1509830957304381450';
const BUY_CATEGORY_ID      = config.buyCategoryId      || '1509830769969729647';
const REQUEST_CATEGORY_ID  = config.requestCategoryId  || '1509830979009773618';
const APPEAL_CATEGORY_ID   = config.appealCategoryId   || '1508084800106528828';
const LOG_CHANNEL_ID       = config.logChannelId       || '1509832784880074782';
const NOWPAYMENTS_API      = 'https://api.nowpayments.io/v1';

// ─── DATA FILES ───────────────────────────────────────────────────────────────
function loadJSON(file, fallback) {
    if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { return fallback; }
    }
    return fallback;
}
function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let keysData         = loadJSON('./keys.json',      { keys: [], subscriptions: [] });
let whitelistedUsers = loadJSON('./whitelist.json', { users: [] });
let logsData         = loadJSON('./logs.json',      { logs: [] });
let giveawaysData    = loadJSON('./giveaways.json', { giveaways: [] });

if (!keysData.keys)             keysData.keys = [];
if (!keysData.subscriptions)    keysData.subscriptions = [];
if (!whitelistedUsers.users)    whitelistedUsers.users = [];
if (!logsData.logs)             logsData.logs = [];
if (!giveawaysData.giveaways)   giveawaysData.giveaways = [];

function saveKeys()      { saveJSON('./keys.json', keysData); }
function saveWhitelist() { saveJSON('./whitelist.json', whitelistedUsers); }
function saveLogs()      { saveJSON('./logs.json', logsData); }
function saveGiveaways() { saveJSON('./giveaways.json', giveawaysData); }

// ─── LOGGING HELPER ───────────────────────────────────────────────────────────
async function logAction(client, type, data) {
    const entry = {
        id: crypto.randomBytes(6).toString('hex'),
        type,
        timestamp: Date.now(),
        ...data
    };
    logsData.logs.unshift(entry);
    if (logsData.logs.length > 2000) logsData.logs = logsData.logs.slice(0, 2000);
    saveLogs();

    try {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (!channel) return;

        const colors = {
            BAN: '#ED4245', TIMEOUT: '#FEE75C', UNBAN: '#57F287',
            KICK: '#FF6B35', TICKET_OPEN: '#5865F2', TICKET_CLOSE: '#EB459E',
            PAYMENT: '#00FF00', KEY_REDEEM: '#57F287', WHITELIST: '#57F287',
            UNWHITELIST: '#ED4245', LINK_DELETE: '#FF6B35', GIVEAWAY: '#FFD700',
            MOD_MSG: '#5865F2', SCRIPT_REQUEST: '#57F287'
        };

        const embed = new EmbedBuilder()
            .setColor(colors[type] || '#5865F2')
            .setTitle(`📋 Log: ${type}`)
            .setTimestamp(entry.timestamp);

        for (const [k, v] of Object.entries(data)) {
            if (v !== undefined && v !== null) {
                embed.addFields({ name: k, value: String(v).slice(0, 1024), inline: true });
            }
        }

        await channel.send({ embeds: [embed] });
    } catch (e) {
        console.error('Log channel error:', e.message);
    }
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration
    ]
});

const activeTickets   = new Map();
const paymentSessions = new Map();
const paymentMonitors = new Map();

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName('redeem')
        .setDescription('Redeem a key')
        .addStringOption(o => o.setName('key').setDescription('Your key').setRequired(true)),
    new SlashCommandBuilder()
        .setName('check')
        .setDescription('Check your subscription'),
    new SlashCommandBuilder()
        .setName('givekey')
        .setDescription('Give a key (Admin)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Duration').setRequired(true)
            .addChoices({ name: '1 Month', value: '1month' }, { name: 'Lifetime', value: 'lifetime' })),
    new SlashCommandBuilder()
        .setName('stock')
        .setDescription('Check stock'),
    new SlashCommandBuilder()
        .setName('whitelist')
        .setDescription('Check your whitelist status'),
    new SlashCommandBuilder()
        .setName('unwhitelist')
        .setDescription('Remove whitelist (Admin)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder()
        .setName('removecooldown')
        .setDescription('Remove cooldown (Admin)')
        .addUserOption(o => o.setName('user').setDescription('User').setRequired(true)),
    new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Start a giveaway (Admin)')
        .addStringOption(o => o.setName('prize').setDescription('Prize').setRequired(true))
        .addStringOption(o => o.setName('duration').setDescription('Duration e.g. 1h, 30m, 1d').setRequired(true))
        .addIntegerOption(o => o.setName('winners').setDescription('Number of winners').setRequired(true)),
    new SlashCommandBuilder()
        .setName('gend')
        .setDescription('End a giveaway early (Admin)')
        .addStringOption(o => o.setName('messageid').setDescription('Message ID of giveaway').setRequired(true)),
    new SlashCommandBuilder()
        .setName('reroll')
        .setDescription('Reroll a giveaway (Admin)')
        .addStringOption(o => o.setName('messageid').setDescription('Message ID of giveaway').setRequired(true)),
];

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`✅ Bot online as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        for (const guild of client.guilds.cache.values()) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
        }
        console.log('✅ Slash commands registered');
    } catch (e) { console.error('Command reg error:', e); }

    setInterval(checkExpiredSubscriptions, 60000);
    setInterval(checkGiveaways, 10000);
});

// ─── MESSAGE CREATE ───────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const isInvite = /discord\.(gg|com\/invite)\/[a-zA-Z0-9]+/i.test(message.content);
    const isLink = /https?:\/\/(?!tenor\.com|giphy\.com|media\.tenor\.com|media\.giphy\.com)[^\s]+/i.test(message.content);

    const memberRoles = message.member?.roles?.cache;
    const hasModRole  = memberRoles?.has(MOD_ROLE_ID)   || false;
    const hasAdmRole  = memberRoles?.has(ADMIN_ROLE_ID)  || false;
    const isAdmin     = ADMIN_USER_IDS.includes(message.author.id);

    if ((isInvite || isLink) && !hasModRole && !hasAdmRole && !isAdmin) {
        try {
            await message.delete();
            await message.member.timeout(10 * 60 * 1000, 'Auto: link/invite detected');

            const dmEmbed = new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('🔇 You have been timed out')
                .setDescription(`**Reason:** Unauthorized link / Discord invite\n**Duration:** 10 minutes`)
                .setTimestamp();
            await message.author.send({ embeds: [dmEmbed] }).catch(() => {});

            await logAction(client, 'LINK_DELETE', {
                'User': `${message.author.tag} (${message.author.id})`,
                'Channel': `#${message.channel.name}`,
                'Content': message.content.slice(0, 500),
                'Action': 'Deleted + 10min timeout'
            });
        } catch (e) { console.error('Anti-link error:', e); }
        return;
    }

    if (message.content.startsWith('!ticket')) {
        const sub = message.content.split(' ')[1]?.toLowerCase();
        if (sub === 'support') return createTicketPanel(message, 'support');
        if (sub === 'buy')     return createTicketPanel(message, 'buy');
        return message.reply('❌ Use: `!ticket support` or `!ticket buy`');
    }

    if (message.content.startsWith('!request')) {
        return createRequestPanel(message);
    }

    if (message.content.startsWith('.timeout ')) {
        if (!hasModRole && !hasAdmRole && !isAdmin) return;
        const parts = message.content.split(' ');
        const targetId = parts[1];
        const reason = parts.slice(2).join(' ') || 'No reason provided';
        try {
            const target = await message.guild.members.fetch(targetId).catch(() => null);
            if (!target) return message.reply('❌ User not found.');
            await target.timeout(10 * 60 * 1000, reason);
            message.reply(`✅ <@${targetId}> got a 10min timeout. Reason: ${reason}`);
            await logAction(client, 'TIMEOUT', {
                'Moderator': `${message.author.tag}`,
                'Target': `${target.user.tag} (${targetId})`,
                'Reason': reason, 'Duration': '10 minutes'
            });
        } catch (e) { message.reply('❌ ' + e.message); }
        return;
    }

    if (message.content.startsWith('.ban ')) {
        if (!hasAdmRole && !isAdmin) return;
        const parts = message.content.split(' ');
        const targetId = parts[1];
        const reason = parts.slice(2).join(' ') || 'Banned by authorized user';
        try {
            const target = await message.guild.members.fetch(targetId).catch(() => null);
            const targetUser = target?.user || await client.users.fetch(targetId).catch(() => null);
            if (!targetUser) return message.reply('❌ User not found.');

            const banEmbed = new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('🔨 You have been banned')
                .addFields(
                    { name: 'Server', value: message.guild.name, inline: true },
                    { name: 'Reason', value: reason, inline: true },
                    { name: 'Want to appeal?', value: 'Open a ticket to appeal your ban.' }
                )
                .setTimestamp();
            await targetUser.send({ embeds: [banEmbed] }).catch(() => {});

            await message.guild.members.ban(targetId, { reason });
            message.reply(`✅ <@${targetId}> has been banned.`);
            await logAction(client, 'BAN', {
                'Moderator': `${message.author.tag}`,
                'Target': `${targetUser.tag} (${targetId})`,
                'Reason': reason
            });
        } catch (e) { message.reply('❌ ' + e.message); }
        return;
    }
});

// ─── GUILD MEMBER ADD (Appeal auto-ticket) ────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
    try {
        const category = member.guild.channels.cache.get(APPEAL_CATEGORY_ID);
        if (!category) return;

        const permissionOverwrites = [
            { id: member.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
        ];

        const ticketChannel = await member.guild.channels.create({
            name: `appeal-${member.user.username}`,
            type: ChannelType.GuildText,
            parent: APPEAL_CATEGORY_ID,
            permissionOverwrites
        });

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('📋 Ban Appeal')
            .setDescription(`Welcome ${member}, your appeal ticket has been created!\n\nPlease describe your situation and why you should be unbanned.\nA staff member will review your appeal as soon as possible.`)
            .setTimestamp();

        const closeBtn = new ButtonBuilder()
            .setCustomId(`close_ticket_${ticketChannel.id}`)
            .setLabel('🔒 Close Ticket')
            .setStyle(ButtonStyle.Danger);

        await ticketChannel.send({ content: `${member} <@&${MOD_ROLE_ID}> <@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [new ActionRowBuilder().addComponents(closeBtn)] });

        await logAction(client, 'TICKET_OPEN', {
            'User': `${member.user.tag} (${member.id})`,
            'Type': 'Ban Appeal (auto)',
            'Channel': ticketChannel.name
        });
    } catch (e) { console.error('Appeal ticket error:', e); }
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('create_ticket_')) return handleTicketCreation(interaction);
            if (interaction.customId.startsWith('close_ticket_'))  return handleTicketClose(interaction);
            if (interaction.customId.startsWith('check_payment_')) return checkPaymentStatus(interaction, interaction.customId.replace('check_payment_', ''));
            if (interaction.customId === 'giveaway_enter')          return handleGiveawayEnter(interaction);
        }
        if (interaction.isStringSelectMenu() && interaction.customId === 'duration_select') {
            return handleDurationSelect(interaction);
        }
        if (interaction.isModalSubmit() && interaction.customId === 'request_modal') {
            return handleRequestModal(interaction);
        }
        if (interaction.isChatInputCommand()) {
            const h = {
                redeem:         handleRedeemCommand,
                check:          handleCheckCommand,
                givekey:        handleGiveKeyCommand,
                stock:          handleStockCommand,
                whitelist:      handleWhitelistCommand,
                unwhitelist:    handleUnwhitelistCommand,
                removecooldown: handleRemoveCooldownCommand,
                giveaway:       handleGiveawayCommand,
                gend:           handleGiveawayEnd,
                reroll:         handleGiveawayReroll,
            };
            if (h[interaction.commandName]) return h[interaction.commandName](interaction);
        }
    } catch (e) {
        console.error('Interaction error:', e);
        const msg = '❌ An error occurred.';
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg }).catch(() => {});
        else await interaction.reply({ content: msg, flags: 64 }).catch(() => {});
    }
});

// ─── TICKET PANELS ────────────────────────────────────────────────────────────
async function createTicketPanel(message, type) {
    const data = {
        support: { color: '#5865F2', title: '🎫 Support Ticket System', desc: 'Click the button to open a support ticket.\nOur team will help you as soon as possible.' },
        buy:     { color: '#FEE75C', title: '💰 Buy Ticket System',     desc: 'Click the button to open a purchase ticket.\nChoose your package and get payment information instantly.' }
    };
    const d = data[type];
    const embed = new EmbedBuilder().setColor(d.color).setTitle(d.title).setDescription(d.desc).setTimestamp();
    const btn = new ButtonBuilder()
        .setCustomId(`create_ticket_${type}`)
        .setLabel(type === 'support' ? '🎫 Open Ticket' : '💰 Buy Now')
        .setStyle(type === 'buy' ? ButtonStyle.Success : ButtonStyle.Primary);
    await message.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
    await message.delete().catch(() => {});
}

async function createRequestPanel(message) {
    const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('📜 Script Request')
        .setDescription('Click the button to request a script!\nOur team will review your request.')
        .setTimestamp();
    const btn = new ButtonBuilder()
        .setCustomId('create_ticket_request')
        .setLabel('📜 Request Script')
        .setStyle(ButtonStyle.Success);
    await message.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
    await message.delete().catch(() => {});
}

// ─── TICKET CREATION ──────────────────────────────────────────────────────────
async function handleTicketCreation(interaction) {
    const type = interaction.customId.replace('create_ticket_', '');
    const userId = interaction.user.id;

    if (type === 'request') {
        const modal = new ModalBuilder()
            .setCustomId('request_modal')
            .setTitle('📜 Script Request');
        const input = new TextInputBuilder()
            .setCustomId('script_name')
            .setLabel('What script would you like to request?')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('e.g., Auto farm script, GUI script, Executor...')
            .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    const existing = Array.from(activeTickets.values()).find(t => t.userId === userId && t.type === type);
    if (existing) return interaction.reply({ content: '❌ You already have an open ticket of this type!', flags: 64 });

    await interaction.deferReply({ flags: 64 });

    const catId = type === 'support' ? SUPPORT_CATEGORY_ID : BUY_CATEGORY_ID;
    const category = interaction.guild.channels.cache.get(catId);
    if (!category) return interaction.editReply({ content: '❌ Category not found!' });

    const num = Math.floor(Math.random() * 9000) + 1000;
    const channelName = `ticket-${type}-${num}`;

    const permissionOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
        { id: MOD_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const ticketChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: catId,
        permissionOverwrites
    });

    activeTickets.set(ticketChannel.id, { userId, type, createdAt: Date.now() });

    const colors = { support: '#5865F2', buy: '#FEE75C' };
    const welcomeEmbed = new EmbedBuilder()
        .setColor(colors[type])
        .setTitle(type === 'support' ? '🎫 Support Ticket' : '💰 Purchase Ticket')
        .setDescription(`Welcome ${interaction.user}!\n\n${type === 'support' ? 'Please describe your issue and a team member will help you.' : 'Please select your desired package.'}`)
        .setFooter({ text: `Ticket #${num}` })
        .setTimestamp();

    const closeBtn = new ButtonBuilder()
        .setCustomId(`close_ticket_${ticketChannel.id}`)
        .setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger);

    let pingContent = `${interaction.user} `;
    if (type === 'support') pingContent += `<@&${MOD_ROLE_ID}> <@&${ADMIN_ROLE_ID}>`;
    if (type === 'buy')     pingContent += `<@&${BUY_PING_ROLE_ID}>`;

    await ticketChannel.send({ content: pingContent, embeds: [welcomeEmbed], components: [new ActionRowBuilder().addComponents(closeBtn)] });

    if (type === 'buy') await handleBuyTicketAutoResponse(ticketChannel, interaction.user);

    await interaction.editReply({ content: `✅ Your ticket has been created: ${ticketChannel}` });

    await logAction(client, 'TICKET_OPEN', {
        'User': `${interaction.user.tag} (${interaction.user.id})`,
        'Type': type, 'Channel': channelName
    });
}

async function handleRequestModal(interaction) {
    const scriptName = interaction.fields.getTextInputValue('script_name');
    const userId = interaction.user.id;

    await interaction.deferReply({ flags: 64 });

    const category = interaction.guild.channels.cache.get(REQUEST_CATEGORY_ID);
    if (!category) return interaction.editReply({ content: '❌ Category not found!' });

    const num = Math.floor(Math.random() * 9000) + 1000;
    const channelName = `request-${interaction.user.username}-${num}`;

    const permissionOverwrites = [
        { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
        { id: MOD_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: ADMIN_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ];

    const ticketChannel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: REQUEST_CATEGORY_ID,
        permissionOverwrites
    });

    activeTickets.set(ticketChannel.id, { userId, type: 'request', createdAt: Date.now() });

    const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('📜 Script Request')
        .setDescription(`${interaction.user} wants to request a script!`)
        .addFields({ name: '📜 Requested Script', value: scriptName })
        .setFooter({ text: `Request #${num}` })
        .setTimestamp();

    const closeBtn = new ButtonBuilder()
        .setCustomId(`close_ticket_${ticketChannel.id}`)
        .setLabel('🔒 Close').setStyle(ButtonStyle.Danger);

    await ticketChannel.send({
        content: `${interaction.user} <@&${MOD_ROLE_ID}> <@&${ADMIN_ROLE_ID}>`,
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(closeBtn)]
    });

    await interaction.editReply({ content: `✅ Your script request has been created: ${ticketChannel}` });

    await logAction(client, 'SCRIPT_REQUEST', {
        'User': `${interaction.user.tag}`,
        'Type': 'Script Request',
        'Script': scriptName,
        'Channel': channelName
    });
}

async function handleBuyTicketAutoResponse(channel, user) {
    const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('⏱️ Select Package')
        .setDescription('Choose your desired package:\n\n**1 Month** — $5.00\n**Lifetime** — $15.00')
        .setFooter({ text: 'Payment information will be shown immediately after selection' })
        .setTimestamp();

    const select = new StringSelectMenuBuilder()
        .setCustomId('duration_select')
        .setPlaceholder('Select package')
        .addOptions([
            { label: '1 Month — $5.00', description: '1 Month access', value: '1month_5', emoji: '📅' },
            { label: 'Lifetime — $15.00', description: 'Lifetime access', value: 'lifetime_15', emoji: '♾️' },
        ]);

    await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(select)] });
}

async function handleDurationSelect(interaction) {
    const [duration, priceStr] = interaction.values[0].split('_');
    const priceUSD = parseFloat(priceStr);
    const durationText = duration === '1month' ? '1 Month' : 'Lifetime';
    const durationMs   = duration === '1month' ? 30 * 24 * 60 * 60 * 1000 : 100 * 365 * 24 * 60 * 60 * 1000;

    await interaction.deferReply();

    try {
        const priceRes = await axios.get(`${NOWPAYMENTS_API}/estimate`, {
            params: { amount: priceUSD, currency_from: 'usd', currency_to: 'ltc' },
            headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
        });
        const ltcAmount = priceRes.data.estimated_amount;

        const payRes = await axios.post(`${NOWPAYMENTS_API}/payment`, {
            price_amount: priceUSD, price_currency: 'usd', pay_currency: 'ltc',
            order_id: `ticket-${interaction.channel.id}-${Date.now()}`,
            order_description: `${durationText} - ${interaction.user.tag}`
        }, { headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' } });

        const payment = payRes.data;
        paymentSessions.set(interaction.channel.id, {
            paymentId: payment.payment_id, userId: interaction.user.id,
            amount: ltcAmount, address: payment.pay_address,
            duration, durationMs, priceUSD, guildId: interaction.guild.id, createdAt: Date.now()
        });

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('💰 Litecoin Payment')
            .setDescription(`**Package:** ${durationText}\n**Price:** $${priceUSD.toFixed(2)} USD\n\nPlease send **${ltcAmount} LTC** to the following address:`)
            .addFields(
                { name: '📍 LTC Address', value: `\`\`\`${payment.pay_address}\`\`\``, inline: false },
                { name: '💵 Amount', value: `**${ltcAmount} LTC**`, inline: true },
                { name: '💲 USD', value: `$${priceUSD.toFixed(2)}`, inline: true },
                { name: '📊 Status', value: '⏳ Waiting for payment...', inline: false }
            )
            .setFooter({ text: 'Send exactly this amount!' }).setTimestamp();

        const checkBtn = new ButtonBuilder()
            .setCustomId(`check_payment_${payment.payment_id}`)
            .setLabel('🔄 Check Payment').setStyle(ButtonStyle.Primary);

        await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(checkBtn)] });
        startPaymentMonitoring(payment.payment_id, interaction.channel.id);

        await logAction(client, 'PAYMENT', {
            'User': `${interaction.user.tag}`,
            'Package': durationText,
            'Amount': `$${priceUSD}`,
            'LTC': `${ltcAmount}`,
            'PaymentID': payment.payment_id
        });
    } catch (e) {
        console.error('Payment error:', e.response?.data || e.message);
        await interaction.editReply({ content: '❌ Error creating payment. Please contact an admin.' });
    }
}

async function checkPaymentStatus(interaction, paymentId) {
    await interaction.deferReply({ flags: 64 });
    try {
        const res = await axios.get(`${NOWPAYMENTS_API}/payment/${paymentId}`, {
            headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
        });
        const status = res.data.payment_status;
        await interaction.editReply({ content: `**Status:** ${status}` });
        if (status === 'finished' || status === 'confirmed') {
            const session = paymentSessions.get(interaction.channel.id);
            if (session) await processSuccessfulPayment(interaction.channel, session);
        }
    } catch (e) {
        await interaction.editReply({ content: '❌ Error checking payment.' });
    }
}

function startPaymentMonitoring(paymentId, channelId) {
    if (paymentMonitors.has(paymentId)) clearInterval(paymentMonitors.get(paymentId));
    const iv = setInterval(async () => {
        try {
            const res = await axios.get(`${NOWPAYMENTS_API}/payment/${paymentId}`, {
                headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY }
            });
            const status = res.data.payment_status;
            if (status === 'finished' || status === 'confirmed') {
                clearInterval(iv); paymentMonitors.delete(paymentId);
                const ch = client.channels.cache.get(channelId);
                const session = paymentSessions.get(channelId);
                if (ch && session) await processSuccessfulPayment(ch, session);
            } else if (status === 'failed' || status === 'expired') {
                clearInterval(iv); paymentMonitors.delete(paymentId);
            }
        } catch {}
    }, 15000);
    paymentMonitors.set(paymentId, iv);
    setTimeout(() => { if (paymentMonitors.has(paymentId)) { clearInterval(paymentMonitors.get(paymentId)); paymentMonitors.delete(paymentId); } }, 3600000);
}

async function processSuccessfulPayment(channel, sessionData) {
    const key = generateKey();
    const expiresAt = Date.now() + sessionData.durationMs;
    keysData.keys.push({ key, userId: sessionData.userId, guildId: sessionData.guildId, duration: sessionData.duration, durationMs: sessionData.durationMs, expiresAt, createdAt: Date.now(), redeemed: false });
    saveKeys();

    const embed = new EmbedBuilder().setColor('#00FF00').setTitle('✅ Payment Confirmed!').setDescription('Your key has been sent via DM.').setTimestamp();
    await channel.send({ embeds: [embed] });

    try {
        const user = await client.users.fetch(sessionData.userId);
        const keyEmbed = new EmbedBuilder()
            .setColor('#00FF00').setTitle('🔑 Your Key')
            .setDescription(`\`\`\`${key}\`\`\`\n\nUse \`/redeem ${key}\` to redeem your key.`)
            .addFields(
                { name: '⏱️ Package', value: sessionData.duration === '1month' ? '1 Month' : 'Lifetime', inline: true },
                { name: '📅 Expires', value: `<t:${Math.floor(expiresAt / 1000)}:F>`, inline: true }
            ).setTimestamp();
        await user.send({ embeds: [keyEmbed] });
    } catch {
        await channel.send({ content: `<@${sessionData.userId}> Could not send DM. Key: \`\`\`${key}\`\`\`` });
    }

    await logAction(client, 'PAYMENT', {
        'User': sessionData.userId, 'Package': sessionData.duration,
        'Price': `$${sessionData.priceUSD}`, 'Key': key, 'Status': 'CONFIRMED'
    });
    paymentSessions.delete(channel.id);
}

function generateKey() {
    return crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

async function handleRedeemCommand(interaction) {
    const keyInput = interaction.options.getString('key');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    await interaction.deferReply({ flags: 64 });

    const keyData = keysData.keys.find(k => k.key === keyInput && k.guildId === guildId);
    if (!keyData)       return interaction.editReply({ content: '❌ Invalid key.' });
    if (keyData.redeemed) return interaction.editReply({ content: '❌ This key has already been redeemed.' });
    if (Date.now() > keyData.expiresAt) return interaction.editReply({ content: '❌ This key has expired.' });

    const existingSub = keysData.subscriptions.find(s => s.userId === userId && s.guildId === guildId && s.active);
    if (existingSub) return interaction.editReply({ content: '❌ You already have an active subscription.' });

    keyData.redeemed = true; keyData.redeemedBy = userId; keyData.redeemedAt = Date.now();
    const expiresAt = Date.now() + keyData.durationMs;
    keysData.subscriptions.push({ userId, guildId, key: keyInput, startedAt: Date.now(), expiresAt, duration: keyData.duration, active: true });
    saveKeys();

    const existing = whitelistedUsers.users.find(u => u.userId === userId && u.guildId === guildId);
    if (!existing) whitelistedUsers.users.push({ userId, guildId, username: interaction.user.tag, whitelistedAt: Date.now(), expiresAt, duration: keyData.duration, active: true });
    else { existing.expiresAt = expiresAt; existing.active = true; existing.duration = keyData.duration; }
    saveWhitelist();

    const embed = new EmbedBuilder().setColor('#00FF00').setTitle('✅ Key Redeemed!')
        .addFields({ name: '📅 Expires', value: `<t:${Math.floor(expiresAt / 1000)}:R>`, inline: true }).setTimestamp();
    await interaction.editReply({ embeds: [embed] });

    await logAction(client, 'KEY_REDEEM', { 'User': `${interaction.user.tag}`, 'Key': keyInput, 'Package': keyData.duration });
}

async function handleCheckCommand(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    await interaction.deferReply({ flags: 64 });
    const sub = keysData.subscriptions.find(s => s.userId === userId && s.guildId === guildId && s.active);
    if (!sub) return interaction.editReply({ content: '❌ No active subscription. Purchase a key using the ticket system.' });
    const tl = sub.expiresAt - Date.now();
    if (tl <= 0) { sub.active = false; saveKeys(); return interaction.editReply({ content: '❌ Your subscription has expired.' }); }
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('⏱️ Subscription Info')
        .addFields(
            { name: '📅 Expires', value: `<t:${Math.floor(sub.expiresAt / 1000)}:F>`, inline: false },
            { name: '⏳ Time Left', value: `${Math.floor(tl/3600000)}h ${Math.floor((tl%3600000)/60000)}m`, inline: true },
            { name: '📦 Package', value: sub.duration === '1month' ? '1 Month' : 'Lifetime', inline: true }
        ).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
}

async function handleWhitelistCommand(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    await interaction.deferReply({ flags: 64 });
    const entry = whitelistedUsers.users.find(u => u.userId === userId && u.guildId === guildId && u.active);
    if (!entry) return interaction.editReply({ content: '❌ You are not whitelisted.' });
    const tl = entry.expiresAt - Date.now();
    if (tl <= 0) { entry.active = false; saveWhitelist(); return interaction.editReply({ content: '❌ Your whitelist has expired.' }); }
    const embed = new EmbedBuilder().setColor('#00FF00').setTitle('✅ Whitelist Status')
        .addFields(
            { name: '📅 Expires', value: `<t:${Math.floor(entry.expiresAt / 1000)}:F>`, inline: false },
            { name: '⏳ Time Left', value: `${Math.floor(tl/3600000)}h ${Math.floor((tl%3600000)/60000)}m`, inline: true }
        ).setTimestamp();
    await interaction.editReply({ embeds: [embed] });
}

async function handleUnwhitelistCommand(interaction) {
    if (!ADMIN_USER_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
    const target = interaction.options.getUser('user');
    await interaction.deferReply({ flags: 64 });
    const entry = whitelistedUsers.users.find(u => u.userId === target.id && u.guildId === interaction.guild.id);
    if (!entry?.active) return interaction.editReply({ content: `❌ ${target} is not whitelisted.` });
    entry.active = false; saveWhitelist();
    const sub = keysData.subscriptions.find(s => s.userId === target.id && s.guildId === interaction.guild.id && s.active);
    if (sub) { sub.active = false; saveKeys(); }
    await interaction.editReply({ content: `✅ ${target} has been removed from the whitelist.` });
    await target.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('❌ Whitelist Removed').setDescription('Your whitelist has been removed by an admin.').setTimestamp()] }).catch(() => {});
    await logAction(client, 'UNWHITELIST', { 'Admin': interaction.user.tag, 'Target': target.tag });
}

async function handleGiveKeyCommand(interaction) {
    if (!ADMIN_USER_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
    const target = interaction.options.getUser('user');
    const duration = interaction.options.getString('duration');
    await interaction.deferReply({ flags: 64 });
    const durationMs = duration === '1month' ? 30*24*60*60*1000 : 100*365*24*60*60*1000;
    const key = generateKey();
    const expiresAt = Date.now() + durationMs;
    keysData.keys.push({ key, userId: target.id, guildId: interaction.guild.id, duration, durationMs, expiresAt, createdAt: Date.now(), redeemed: false, givenBy: interaction.user.id });
    saveKeys();
    try {
        await target.send({ embeds: [new EmbedBuilder().setColor('#00FF00').setTitle('🎁 Key Received!')
            .setDescription(`\`\`\`${key}\`\`\`\n\nUse \`/redeem ${key}\` to redeem.`)
            .addFields({ name: '⏱️ Package', value: duration === '1month' ? '1 Month' : 'Lifetime', inline: true }).setTimestamp()] });
    } catch {}
    await interaction.editReply({ content: `✅ Key sent to ${target}: \`${key}\`` });
    await logAction(client, 'WHITELIST', { 'Admin': interaction.user.tag, 'Target': target.tag, 'Key': key, 'Duration': duration });
}

async function handleStockCommand(interaction) {
    await interaction.deferReply({ flags: 64 });
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('📊 Stock').setDescription('No generator active. Use tickets to purchase access.').setTimestamp();
    await interaction.editReply({ embeds: [embed] });
}

async function handleRemoveCooldownCommand(interaction) {
    if (!ADMIN_USER_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ No permission.', flags: 64 });
    await interaction.deferReply({ flags: 64 });
    await interaction.editReply({ content: '✅ Cooldowns are currently not active.' });
}

async function handleTicketClose(interaction) {
    const channelId = interaction.customId.replace('close_ticket_', '');
    const channel = interaction.guild.channels.cache.get(channelId);
    if (!channel) return interaction.reply({ content: '❌ Ticket channel not found.', flags: 64 });

    await interaction.reply({ content: '🔒 Closing ticket...', flags: 64 });
    await channel.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('🔒 Ticket Closed').setDescription(`Closed by ${interaction.user}`).setTimestamp()] });

    await logAction(client, 'TICKET_CLOSE', {
        'Closed by': `${interaction.user.tag}`,
        'Channel': channel.name,
        'Type': activeTickets.get(channelId)?.type || 'unknown'
    });

    activeTickets.delete(channelId);
    paymentSessions.delete(channelId);

    setTimeout(() => channel.delete().catch(() => {}), 5000);
}

async function checkExpiredSubscriptions() {
    const now = Date.now(); let changed = false;
    for (const sub of keysData.subscriptions) {
        if (sub.active && sub.expiresAt <= now) {
            sub.active = false; changed = true;
            const wl = whitelistedUsers.users.find(u => u.userId === sub.userId && u.guildId === sub.guildId);
            if (wl) { wl.active = false; saveWhitelist(); }
            try {
                const user = await client.users.fetch(sub.userId);
                await user.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('⏰ Subscription Expired').setDescription('Your subscription has expired.').setTimestamp()] }).catch(() => {});
            } catch {}
        }
    }
    if (changed) saveKeys();
}

function parseDuration(str) {
    const match = str.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const v = parseInt(match[1]);
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return v * mult[match[2]];
}

async function handleGiveawayCommand(interaction) {
    if (!ADMIN_USER_IDS.includes(interaction.user.id) &&
        !interaction.member.roles.cache.has(MOD_ROLE_ID) &&
        !interaction.member.roles.cache.has(ADMIN_ROLE_ID))
        return interaction.reply({ content: '❌ No permission.', flags: 64 });

    const prize    = interaction.options.getString('prize');
    const durStr   = interaction.options.getString('duration');
    const winners  = interaction.options.getInteger('winners');
    const durMs    = parseDuration(durStr);
    if (!durMs) return interaction.reply({ content: '❌ Invalid duration. e.g., 1h, 30m, 1d', flags: 64 });

    await interaction.deferReply();
    const endsAt = Date.now() + durMs;

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🎉 GIVEAWAY')
        .setDescription(`**Prize:** ${prize}\n\nClick 🎉 to participate!\n\n**Winners:** ${winners}\n**Ends:** <t:${Math.floor(endsAt/1000)}:R>`)
        .setFooter({ text: `${winners} winner(s)` })
        .setTimestamp(endsAt);

    const btn = new ButtonBuilder().setCustomId('giveaway_enter').setLabel('🎉 Participate').setStyle(ButtonStyle.Primary);
    const msg = await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });

    const giveaway = { messageId: msg.id, channelId: interaction.channel.id, guildId: interaction.guild.id, prize, winners, endsAt, participants: [], ended: false, hostedBy: interaction.user.id };
    giveawaysData.giveaways.push(giveaway);
    saveGiveaways();

    await logAction(client, 'GIVEAWAY', { 'Host': interaction.user.tag, 'Prize': prize, 'Winners': winners, 'Duration': durStr });
}

async function handleGiveawayEnter(interaction) {
    const giveaway = giveawaysData.giveaways.find(g => g.messageId === interaction.message.id && !g.ended);
    if (!giveaway) return interaction.reply({ content: '❌ This giveaway has ended.', flags: 64 });
    if (giveaway.participants.includes(interaction.user.id)) return interaction.reply({ content: '✅ You are already participating!', flags: 64 });
    giveaway.participants.push(interaction.user.id);
    saveGiveaways();
    await interaction.reply({ content: '✅ You are now participating in the giveaway! Good luck! 🎉', flags: 64 });
}

async function endGiveaway(giveaway) {
    giveaway.ended = true; saveGiveaways();
    try {
        const channel = await client.channels.fetch(giveaway.channelId);
        const winners = [];
        const pool = [...giveaway.participants];
        const count = Math.min(giveaway.winners, pool.length);
        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * pool.length);
            winners.push(pool.splice(idx, 1)[0]);
        }

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🎉 GIVEAWAY ENDED')
            .setDescription(`**Prize:** ${giveaway.prize}\n\n**Winner(s):** ${winners.length ? winners.map(w => `<@${w}>`).join(', ') : 'No participants'}`)
            .setTimestamp();

        await channel.send({ embeds: [embed], content: winners.length ? `🎉 Congratulations ${winners.map(w=>`<@${w}>`).join(' ')}!` : 'No winner.' });
    } catch (e) { console.error('End giveaway error:', e); }
}

async function handleGiveawayEnd(interaction) {
    if (!ADMIN_USER_IDS.includes(interaction.user.id) && !interaction.member.roles.cache.has(ADMIN_ROLE_ID))
        return interaction.reply({ content: '❌ No permission.', flags: 64 });
    const msgId = interaction.options.getString('messageid');
    const gw = giveawaysData.giveaways.find(g => g.messageId === msgId && !g.ended);
    if (!gw) return interaction.reply({ content: '❌ Giveaway not found.', flags: 64 });
    await endGiveaway(gw);
    await interaction.reply({ content: '✅ Giveaway ended.', flags: 64 });
}

async function handleGiveawayReroll(interaction) {
    if (!ADMIN_USER_IDS.includes(interaction.user.id) && !interaction.member.roles.cache.has(ADMIN_ROLE_ID))
        return interaction.reply({ content: '❌ No permission.', flags: 64 });
    const msgId = interaction.options.getString('messageid');
    const gw = giveawaysData.giveaways.find(g => g.messageId === msgId);
    if (!gw) return interaction.reply({ content: '❌ Giveaway not found.', flags: 64 });
    gw.ended = false; await endGiveaway(gw);
    await interaction.reply({ content: '✅ Reroll completed.', flags: 64 });
}

async function checkGiveaways() {
    const now = Date.now();
    for (const gw of giveawaysData.giveaways) {
        if (!gw.ended && gw.endsAt <= now) await endGiveaway(gw);
    }
}

// ─── EXPRESS WEB DASHBOARD ───────────────────────────────────────────────────
const appExpress = express();

// CORS Middleware
appExpress.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (origin.includes('netlify.app') || origin.includes('localhost'))) {
        res.header('Access-Control-Allow-Origin', origin);
    } else {
        res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

appExpress.use(express.json());

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

// Auth Route
appExpress.post('/api/auth', (req, res) => {
    if (req.body.password === DASHBOARD_PASSWORD) {
        res.json({ ok: true, token: Buffer.from(DASHBOARD_PASSWORD).toString('base64') });
    } else {
        res.status(401).json({ ok: false });
    }
});

function authMiddleware(req, res, next) {
    const token = req.headers['authorization'];
    if (token === Buffer.from(DASHBOARD_PASSWORD).toString('base64')) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// API Routes
appExpress.get('/api/logs', authMiddleware, (req, res) => {
    const page = parseInt(req.query.page) || 0;
    const limit = 50;
    const type = req.query.type;
    let logs = logsData.logs;
    if (type) logs = logs.filter(l => l.type === type);
    res.json({ logs: logs.slice(page * limit, (page+1) * limit), total: logs.length });
});

appExpress.get('/api/stats', authMiddleware, (req, res) => {
    const activeSubs = keysData.subscriptions.filter(s => s.active).length;
    const totalKeys  = keysData.keys.length;
    const totalLogs  = logsData.logs.length;
    const activeWL   = whitelistedUsers.users.filter(u => u.active).length;
    res.json({ activeSubs, totalKeys, totalLogs, activeWL });
});

appExpress.get('/api/guilds', authMiddleware, (req, res) => {
    const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name, memberCount: g.memberCount }));
    res.json(guilds);
});

appExpress.get('/api/channels/:guildId', authMiddleware, async (req, res) => {
    try {
        const guild = client.guilds.cache.get(req.params.guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        const channels = guild.channels.cache
            .filter(c => c.type === ChannelType.GuildText && c.viewable)
            .map(c => ({ id: c.id, name: c.name }));
        res.json(channels);
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

appExpress.post('/api/send', authMiddleware, async (req, res) => {
    try {
        const { guildId, channelId, content, useEmbed, embedData, everyone, here } = req.body;
        
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).json({ error: 'Guild not found' });
        
        const channel = guild.channels.cache.get(channelId);
        if (!channel) return res.status(404).json({ error: 'Channel not found' });
        
        const botMember = guild.members.cache.get(client.user.id);
        if (!channel.permissionsFor(botMember).has('SendMessages')) {
            return res.status(403).json({ error: 'Bot has no permission to send messages in this channel' });
        }

        let msgContent = content || '';
        if (everyone) msgContent = '@everyone ' + msgContent;
        if (here) msgContent = '@here ' + msgContent;

        if (useEmbed && embedData) {
            const embed = new EmbedBuilder()
                .setColor(embedData.color || '#5865F2')
                .setTitle(embedData.title || '')
                .setDescription(embedData.description || '');
            if (embedData.footer) embed.setFooter({ text: embedData.footer });
            
            await channel.send({ 
                content: msgContent || undefined, 
                embeds: [embed], 
                allowedMentions: { parse: everyone || here ? ['everyone', 'here'] : [] } 
            });
        } else {
            await channel.send({ 
                content: msgContent, 
                allowedMentions: { parse: everyone || here ? ['everyone', 'here'] : [] } 
            });
        }
        
        res.json({ ok: true });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

const PORT = process.env.PORT || 3000;
appExpress.listen(PORT, '0.0.0.0', () => console.log(`🌐 Dashboard API on port ${PORT}`));

// ─── BOT LOGIN ────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);

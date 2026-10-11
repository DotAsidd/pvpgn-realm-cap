--[[
	Realm Chat / Main Chat Bridge Command
	Allows players inside a game or lobby to route their message to Main Chat (Channel & QML)
]]--

local function is_account_muted(uname)
	local m = account_get_auth_mute(uname)
	if m ~= true and m ~= 1 and m ~= "true" and m ~= "1" then
		return false
	end
	local mtime = account_get_auth_mutetime(uname)
	if mtime and tonumber(mtime) and tonumber(mtime) > 0 and os.time() > tonumber(mtime) then
		account_set_auth_mute(uname, false)
		account_set_auth_mutetime(uname, 0)
		return false
	end
	return true
end

function command_realm_chat(account, text)
	if not account then return 0 end

	-- Check if user is muted
	if is_account_muted(account.name) then
		local reason = account_get_auth_mutereason(account.name)
		if not reason or #reason == 0 then reason = "Rule violation" end
		api.message_send_text(account.name, message_type_error, nil, "[MUTED] You cannot use /rc. Reason: " .. reason)
		return 0
	end

	local args = split_command(text, 1)
	local msg = args[1]
	if not msg or string:empty(msg) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /rc <message> (sends to Main Chat)")
		return 0
	end

	local clean_msg = string.gsub(msg, "[\r\n\t]+", " ")
	if #clean_msg == 0 then return 0 end

	-- 1. Forward to Web & QML Main Chat
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(account.name .. "\tDotA and Friends\t" .. clean_msg .. "\n")
		f:close()
	end

	-- 2. Deliver to Main Chat (all connected users)
	local formatted = "[Main] <" .. account.name .. "> " .. clean_msg
	for i, acc in pairs(api.server_get_users()) do
		if acc and acc.name then
			api.message_send_text(acc.name, message_type_info, nil, formatted)
			-- If in lobby or match, whisper so it renders on screen
			if acc.game_id and acc.game_id > 0 and acc.name ~= account.name then
				api.message_send_text(acc.name, message_type_whisper, "MainChat", formatted)
			end
		end
	end

	-- 3. Confirm to sender on screen
	api.message_send_text(account.name, message_type_info, nil, "[Main Chat Sent] " .. clean_msg)
	return 0
end

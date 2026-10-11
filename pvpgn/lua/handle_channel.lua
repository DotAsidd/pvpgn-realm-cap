--[[
	Copyright (C) 2014 HarpyWar (harpywar@gmail.com)
	
	This file is a part of the PvPGN Project http://pvpgn.pro
	Licensed under the same terms as Lua itself.
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

function handle_channel_message(channel, account, text, message_type)
	if config.quiz and channel.name == config.quiz_channel then
		quiz_handle_message(account.name, text)
	end

	-- Mute Check: Block muted accounts from speaking and send fallback error notice
	if account and account.name then
		if is_account_muted(account.name) then
			local reason = account_get_auth_mutereason(account.name)
			if not reason or #reason == 0 then reason = "Rule violation" end
			api.message_send_text(account.name, message_type_error, nil, "[MUTED] You cannot speak in chat. Reason: " .. reason)
			return 0
		end
	end

	-- Realm Chat Bridge: Forward Battle.net channel chat to Web / QML
	if account and text and #text > 0 and not string.starts(text, "[Main]") and not string.starts(text, "[Realm]") and not string.starts(text, "[Web]") then
		local cname = channel and channel.name or "DotA and Friends"
		local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
		if f then
			local clean = string.gsub(text, "[\r\n\t]+", " ")
			f:write(account.name .. "\t" .. cname .. "\t" .. clean .. "\n")
			f:close()
		end
	end
end
function handle_channel_userjoin(channel, account)
	--DEBUG(account.name.." joined "..channel.name)
end
function handle_channel_userleft(channel, account)
	--DEBUG(account.name.." left "..channel.name)
end

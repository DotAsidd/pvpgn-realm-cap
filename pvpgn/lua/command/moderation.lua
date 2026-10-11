--[[
	Moderation Commands: /mute, /unmute, /warn, /topic
	Synchronizes with PvPGN native auth attributes and Web Admin Portal
]]--

-- Check if user is an authorized moderator or admin
local function is_moderator(account)
	if not account or not account.name then return false end
	if account_is_operator_or_admin and account_is_operator_or_admin(account.name) then
		return true
	end
	local groups = account_get_auth_command_groups and account_get_auth_command_groups(account.name) or 0
	if math_and(groups, 8) > 0 or math_and(groups, 2) > 0 then
		return true
	end
	return false
end

-- /mute <username> [minutes] [reason]
function command_mute(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 3)
	local target = args[1]
	if not target or string:empty(target) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /mute <username> [minutes] [reason]")
		return 0
	end

	local minutes = tonumber(args[2])
	local reason = ""
	if minutes then
		reason = args[3] or "Muted by moderator"
	else
		minutes = 0
		local p = string.find(text, "%s+")
		if p then
			local after_cmd = string.sub(text, p + 1):match("^%s*(.-)%s*$")
			local p2 = string.find(after_cmd, "%s+")
			if p2 then
				reason = string.sub(after_cmd, p2 + 1):match("^%s*(.-)%s*$") or "Muted by moderator"
			else
				reason = "Muted by moderator"
			end
		else
			reason = "Muted by moderator"
		end
	end

	local target_clean = target:match("^%s*(.-)%s*$")
	local duration_text = minutes > 0 and (minutes .. " minute(s)") or "permanently"
	local exp_timestamp = minutes > 0 and (os.time() + (minutes * 60)) or 0

	account_set_auth_mute(target_clean, true)
	account_set_auth_mutetime(target_clean, exp_timestamp)
	account_set_auth_mutereason(target_clean, reason)
	account_set_auth_muteby(target_clean, account.name)

	-- Direct screen notifications to player
	api.message_send_text(target_clean, message_type_error, nil, string.format("[MUTED] You have been muted by %s for %s. Reason: %s", account.name, duration_text, reason))
	api.message_send_text(target_clean, message_type_whisper, account.name, string.format("[MUTED] You have been muted for %s. Reason: %s", duration_text, reason))

	-- Confirmation to moderator
	api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] User '%s' muted %s. Reason: %s", target_clean, duration_text, reason))

	-- Sync event to Web Portal
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(string.format("__MUTE__\t%s\t%s\t%s\t%d\n", target_clean, account.name, reason, minutes))
		f:close()
	end

	return 0
end

-- /unmute <username>
function command_unmute(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 1)
	local target = args[1]
	if not target or string:empty(target) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /unmute <username>")
		return 0
	end

	local target_clean = target:match("^%s*(.-)%s*$")

	account_set_auth_mute(target_clean, false)
	account_set_auth_mutetime(target_clean, 0)
	account_set_auth_mutereason(target_clean, "")

	-- Direct screen notifications to player
	api.message_send_text(target_clean, message_type_info, nil, string.format("[UNMUTED] Your chat privileges have been restored by %s.", account.name))
	api.message_send_text(target_clean, message_type_whisper, account.name, "[UNMUTED] Your chat privileges have been restored.")

	-- Confirmation to moderator
	api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] User '%s' has been unmuted.", target_clean))

	-- Sync event to Web Portal
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(string.format("__UNMUTE__\t%s\t%s\n", target_clean, account.name))
		f:close()
	end

	return 0
end

-- /warn <username> <message>
function command_warn(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 2)
	local target = args[1]
	local warn_msg = args[2]
	if not target or string:empty(target) or not warn_msg or string:empty(warn_msg) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /warn <username> <message>")
		return 0
	end

	local target_clean = target:match("^%s*(.-)%s*$")
	local clean_msg = string.gsub(warn_msg, "[\r\n\t]+", " ")

	-- Direct screen notifications to player
	api.message_send_text(target_clean, message_type_error, nil, string.format("[ADMIN WARNING from %s] %s", account.name, clean_msg))
	api.message_send_text(target_clean, message_type_whisper, account.name, string.format("[ADMIN WARNING] %s", clean_msg))

	-- Confirmation to moderator
	api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] Warning sent to '%s': %s", target_clean, clean_msg))

	-- Sync event to Web Portal
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(string.format("__WARN__\t%s\t%s\t%s\n", target_clean, account.name, clean_msg))
		f:close()
	end

	return 0
end

-- /topic [new_topic]
function command_topic(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 1)
	local topic = args[1]
	if not topic or string:empty(topic) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /topic <channel topic>")
		return 0
	end

	local clean_topic = string.gsub(topic, "[\r\n\t]+", " ")

	-- Broadcast topic to channel
	local formatted = string.format("[Channel Topic set by %s] %s", account.name, clean_topic)
	for i, acc in pairs(api.server_get_users()) do
		if acc and acc.name then
			api.message_send_text(acc.name, message_type_info, nil, formatted)
		end
	end

	-- Sync event to Web Portal
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(string.format("__TOPIC__\t%s\t%s\n", account.name, clean_topic))
		f:close()
	end

	return 1
end

-- /ban <username> [reason]
function command_ban(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 2)
	local target = args[1]
	if not target or string:empty(target) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /ban <username> [reason]")
		return 0
	end

	local target_clean = target:match("^%s*(.-)%s*$")
	if string.sub(target_clean, 1, 1) == "#" then
		local uid = tonumber(string.sub(target_clean, 2))
		if uid and api.account_get_name_by_uid then
			local resolved = api.account_get_name_by_uid(uid)
			if resolved and not string:empty(resolved) then
				target_clean = resolved
			end
		end
	end

	if target_clean:lower() == "sidd" then
		api.message_send_text(account.name, message_type_error, nil, "Cannot ban root administrator.")
		return 0
	end

	local raw_rest = args[2] or "Banned by administrator"
	local duration_seconds = 0
	local duration_label = "Permanent"
	local clean_reason = raw_rest

	-- Check for duration prefix: e.g. 1h, 12h, 1d, 3d, 7d, 30m, 60s, or digits like 1 (default hours)
	local time_val, time_unit, rest_reason = string.match(raw_rest, "^(%d+)([smhdwSMHDW]?)(%s*.*)$")
	if time_val then
		time_val = tonumber(time_val)
		time_unit = string.lower(time_unit or "")
		if time_unit == "s" then
			duration_seconds = time_val
			duration_label = time_val .. "s"
		elseif time_unit == "m" then
			duration_seconds = time_val * 60
			duration_label = time_val .. "m"
		elseif time_unit == "h" or time_unit == "" then
			duration_seconds = time_val * 3600
			duration_label = time_val .. "h"
		elseif time_unit == "d" then
			duration_seconds = time_val * 86400
			duration_label = time_val .. "d"
		elseif time_unit == "w" then
			duration_seconds = time_val * 7 * 86400
			duration_label = time_val .. "w"
		end

		rest_reason = rest_reason:match("^%s*(.-)%s*$")
		if rest_reason and rest_reason ~= "" then
			clean_reason = rest_reason
		else
			clean_reason = "Banned by administrator (" .. duration_label .. ")"
		end
	end
	clean_reason = string.gsub(clean_reason, "[\r\n\t]+", " ")

	-- Resolve target IP from active connections
	local target_ip = ""
	for i, acc in pairs(api.server_get_users()) do
		if acc and acc.name and acc.name:lower() == target_clean:lower() then
			local u_ip = acc.ip or acc.address
			if u_ip and string.len(u_ip) > 0 then
				target_ip = u_ip
				break
			end
		end
	end

	-- If target clean is directly an IP
	if string.match(target_clean, "^%d+%.%d+%.%d+%.%d+") then
		target_ip = target_clean
		local f_ban = io.open("/etc/pvpgn/bnban.conf", "a")
		if f_ban then
			f_ban:write(target_clean .. "\n")
			f_ban:close()
		end

		for i, acc in pairs(api.server_get_users()) do
			if acc and acc.name then
				local u_ip = acc.ip or acc.address or ""
				if u_ip == target_clean or string.find(u_ip, "^" .. string.gsub(target_clean, "%.", "%%.")) then
					if acc.name:lower() ~= "sidd" then
						api.message_send_text(acc.name, message_type_error, nil, "[IP BANNED] " .. clean_reason)
						api.client_kill(acc.name)
					end
				end
			end
		end
	else
		-- Account ban: disconnect target user session
		api.client_kill(target_clean)
	end

	-- Lock target account in PvPGN memory & storage
	local lock_time = 0
	if duration_seconds > 0 then
		lock_time = os.time() + duration_seconds
	end
	account_set_auth_lock(target_clean, true)
	account_set_auth_lockreason(target_clean, clean_reason)
	account_set_auth_lockby(target_clean, account.name)
	account_set_auth_locktime(target_clean, lock_time)

	-- Direct notifications
	local notif_msg = string.format("[BANNED] Account locked (%s): %s", duration_label, clean_reason)
	api.message_send_text(target_clean, message_type_error, nil, notif_msg)
	api.message_send_text(target_clean, message_type_whisper, account.name, notif_msg)

	-- Terminate connection immediately
	api.client_kill(target_clean)

	-- Confirmation to moderator
	local ip_display = (target_ip ~= "") and target_ip or "resolving via DB"
	if duration_seconds > 0 then
		api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] User '%s' (IP: %s) banned for %s. Reason: %s", target_clean, ip_display, duration_label, clean_reason))
	else
		api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] User '%s' (IP: %s) permanently banned. Reason: %s", target_clean, ip_display, clean_reason))
	end

	-- Sync event to Web Portal & MySQL (includes duration_seconds)
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(string.format("__BAN__\t%s\t%s\t%s\t%s\t%d\n", target_clean, account.name, clean_reason, target_ip, duration_seconds))
		f:close()
	end

	return 0
end

-- /unban <username>
function command_unban(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 1)
	local target = args[1]
	if not target or string:empty(target) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /unban <username>")
		return 0
	end

	local target_clean = target:match("^%s*(.-)%s*$")
	account_set_auth_lock(target_clean, false)
	account_set_auth_locktime(target_clean, 0)
	account_set_auth_lockreason(target_clean, "")
	api.message_send_text(target_clean, message_type_info, nil, string.format("[UNLOCKED] Your account has been unlocked by %s.", account.name))
	api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] User '%s' has been unlocked.", target_clean))

	-- Sync event to Web Portal & MySQL
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(string.format("__UNBAN__\t%s\t%s\n", target_clean, account.name))
		f:close()
	end

	return 0
end

-- /kick <username> [reason]
function command_kick(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 2)
	local target = args[1]
	if not target or string:empty(target) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /kick <username> [reason]")
		return 0
	end

	local target_clean = target:match("^%s*(.-)%s*$")
	if target_clean:lower() == "sidd" then
		api.message_send_text(account.name, message_type_error, nil, "Cannot kick root administrator.")
		return 0
	end

	local reason = args[2] or "Kicked by administrator"
	local clean_reason = string.gsub(reason, "[\r\n\t]+", " ")

	api.message_send_text(target_clean, message_type_error, nil, string.format("[KICKED] You have been kicked by %s: %s", account.name, clean_reason))
	api.client_kill(target_clean)

	api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] User '%s' has been kicked.", target_clean))
	return 0
end

-- /ipban <ip_or_user> [reason]
function command_ipban(account, text)
	if not account then return 0 end
	if not is_moderator(account) then
		api.message_send_text(account.name, message_type_error, nil, "This command is reserved for moderators and admins.")
		return 0
	end

	local args = split_command(text, 2)
	local target = args[1]
	if not target or string:empty(target) then
		api.message_send_text(account.name, message_type_info, nil, "Usage: /ipban <ip|username> [reason]")
		return 0
	end

	local target_clean = target:match("^%s*(.-)%s*$")
	local reason = args[2] or "IP banned by administrator"
	local clean_reason = string.gsub(reason, "[\r\n\t]+", " ")

	local target_ip = target_clean
	-- If target does not look like an IP, search online users for their address
	if not string.match(target_clean, "^%d+%.%d+%.%d+%.%d+") then
		for i, acc in pairs(api.server_get_users()) do
			if acc and acc.name and acc.name:lower() == target_clean:lower() then
				local u_ip = acc.ip or acc.address
				if u_ip and string.len(u_ip) > 0 then
					target_ip = u_ip
					break
				end
			end
		end
	end

	if not string.match(target_ip, "^%d+%.%d+%.%d+%.%d+") then
		api.message_send_text(account.name, message_type_error, nil, "Could not resolve valid IP for target: " .. target_clean)
		return 0
	end

	-- Append to /etc/pvpgn/bnban.conf
	local f_ban = io.open("/etc/pvpgn/bnban.conf", "a")
	if f_ban then
		f_ban:write(target_ip .. "\n")
		f_ban:close()
	end

	-- Disconnect any active connections from that IP
	for i, acc in pairs(api.server_get_users()) do
		if acc and acc.name then
			local u_ip = acc.ip or acc.address or ""
			if u_ip == target_ip or string.find(u_ip, "^" .. string.gsub(target_ip, "%.", "%%.")) then
				if acc.name:lower() ~= "sidd" then
					api.message_send_text(acc.name, message_type_error, nil, "[IP BANNED] " .. clean_reason)
					api.client_kill(acc.name)
				end
			end
		end
	end

	api.message_send_text(account.name, message_type_info, nil, string.format("[Moderation] IP '%s' banned and active sessions terminated.", target_ip))

	-- Signal rehash via web pipe
	local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
	if f then
		f:write(string.format("__IPBAN__\t%s\t%s\t%s\n", target_ip, account.name, clean_reason))
		f:close()
	end

	return 0
end

--[[
	Copyright (C) 2014 HarpyWar (harpywar@gmail.com)
	
	This file is a part of the PvPGN Project http://pvpgn.pro
	Licensed under the same terms as Lua itself.
]]--


-- List of available lua commands
--  (To create a new command - create a new file in directory "commands")
local lua_command_table = {
	[1] = {
		["/w3motd"] = "command_w3motd",
		["/rc"] = "command_realm_chat",
		["/realm"] = "command_realm_chat",

		-- Quiz
		["/quiz"] = "command_quiz",
		
		-- GHost
		["/ghost"] = "command_ghost",
		
		["/host"] = "command_host",
		["/chost"] = "command_chost",
		["/unhost"] = "command_unhost",
		["/ping"] = "command_ping", ["/p"] = "command_ping",
		["/swap"] = "command_swap",
		["/open"] = "command_open_close",
		["/close"] = "command_open_close",
		["/start"] = "command_start_abort_pub_priv", 
		["/abort"] = "command_start_abort_pub_priv",
		["/pub"] = "command_start_abort_pub_priv",
		["/priv"] = "command_start_abort_pub_priv",
		["/stats"] = "command_stats",

		-- Moderation
		["/mute"] = "command_mute",
		["/unmute"] = "command_unmute",
		["/warn"] = "command_warn",
		["/topic"] = "command_topic",
		["/ban"] = "command_ban",
		["/unban"] = "command_unban",
		["/kick"] = "command_kick",
		["/ipban"] = "command_ipban",
	},
	[8] = {
		["/redirect"] = "command_redirect",
	},
}


-- Global function to handle commands
--   ("return 1" from a command will allow next C++ code execution)
function handle_command(account, text)
	-- Track real-time DND and Away presence changes
	if string.starts(text, "/dnd") or string.starts(text, "/away") or string.starts(text, "/afk") then
		local is_dnd = string.starts(text, "/dnd")
		local rest = is_dnd and string.sub(text, 5) or (string.starts(text, "/afk") and string.sub(text, 5) or string.sub(text, 6))
		rest = rest and rest:match("^%s*(.-)%s*$") or ""

		local cmd_type = is_dnd and "DND" or "AWAY"
		if rest == "" then
			if is_dnd then
				if account.dnd and string.len(account.dnd) > 0 then
					cmd_type = "ONLINE"
					rest = ""
				else
					cmd_type = "DND"
					rest = "Do Not Disturb"
				end
			else
				if account.away and string.len(account.away) > 0 then
					cmd_type = "ONLINE"
					rest = ""
				else
					cmd_type = "AWAY"
					rest = "Currently not available"
				end
			end
		end

		local f = io.open("/var/pvpgn/bnet_to_web.pipe", "a")
		if f then
			f:write(string.format("__PRESENCE__\t%s\t%s\t%s\n", account.name, cmd_type, rest or ""))
			f:close()
		end
		-- Return 1 to allow C++ PvPGN _handle_dnd_command / _handle_away_command to execute normally
		return 1
	end

	-- find command in table
	local text_lower = string.lower(text)
	for cg,cmdlist in pairs(lua_command_table) do
		for cmd,func in pairs(cmdlist) do
			if text == cmd or text_lower == cmd or string.starts(text, cmd .. " ") or string.starts(text_lower, cmd .. " ") then
				
				-- check if caller has permission (operator/admin or command group)
				local is_allowed = false
				if account_is_operator_or_admin and account_is_operator_or_admin(account.name) then
					is_allowed = true
				elseif account_get_auth_admin and account_get_auth_admin(account.name) then
					is_allowed = true
				elseif account_get_auth_operator and account_get_auth_operator(account.name) then
					is_allowed = true
				elseif math_and(account_get_auth_command_groups(account.name), cg) ~= 0 then
					is_allowed = true
				end

				if not is_allowed then
					api.message_send_text(account.name, message_type_error, account.name, localize(account.name, "This command is reserved for admins."))
					return -1
				end
				
				local fn = (type(func) == "function") and func or _G[func]
				if fn then
					return fn(account, text)
				else
					return 1
				end
			end
		end
	end
	return 1
end


-- Executes before executing any command
-- "return 0" stay with flood protection
-- "return 1" allow ignore flood protection
-- "return -1" will prevent next command execution silently
function handle_command_before(account, text)
	-- special users
	for k,username in pairs(config.flood_immunity_users) do
		if (username == account.name) then return 1 end
	end

	if (config.ghost) then
		-- ghost bots
		for k,username in pairs(config.ghost_bots) do
			if (username == account.name) then return 1 end
		end
	end
	
	return 0
end


-- Split command to arguments, 
--  index 0 is always a command name without a slash 
--  return table with arguments
function split_command(text, args_count)
	local count = args_count
	local result = {}
	local tmp = ""
	
	-- remove slash from the command
	if not string:empty(text) then
		text = string.sub(text, 2)
	end

	i = 0
	-- split by space
	for token in string.split(text) do
		if not string:empty(token) then 
			if (i < count) then
				result[i] = token 
				i = i + 1
			else
				if not string:empty(tmp) then
					tmp = tmp .. " "
				end
				tmp = tmp .. token
			end
		end
	end
	-- push remaining text at the end
	if not string:empty(tmp) then
    	result[count] = tmp
	end
	return result
end


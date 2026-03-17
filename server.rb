require "json"
require "securerandom"
require "time"
require "thread"
require "webrick"

PORT = 4567
DATA_FILE = File.expand_path("data.json", __dir__)
STARTING_COINS = 20

MIME_TYPES = {
  ".html" => "text/html; charset=utf-8",
  ".css" => "text/css; charset=utf-8",
  ".js" => "application/javascript; charset=utf-8",
  ".json" => "application/json; charset=utf-8"
}.freeze

LOCK = Mutex.new

def ensure_data_file!
  return if File.exist?(DATA_FILE)

  initial_state = {
    "users" => [],
    "challenges" => []
  }

  File.write(DATA_FILE, JSON.pretty_generate(initial_state))
end

def load_state
  ensure_data_file!
  JSON.parse(File.read(DATA_FILE))
rescue JSON::ParserError
  { "users" => [], "challenges" => [] }
end

def save_state(state)
  File.write(DATA_FILE, JSON.pretty_generate(state))
end

def with_state
  LOCK.synchronize do
    state = load_state
    result = yield(state)
    save_state(state)
    result
  end
end

def json_response(res, status, payload)
  res.status = status
  res["Content-Type"] = "application/json; charset=utf-8"
  res.body = JSON.generate(payload)
end

def error!(res, status, message)
  json_response(res, status, { error: message })
end

def read_json_body(req)
  body = req.body.to_s
  return {} if body.empty?

  JSON.parse(body)
rescue JSON::ParserError
  {}
end

def find_user(state, user_id)
  state["users"].find { |user| user["id"] == user_id }
end

def reserved_coins(state, user_id)
  state["challenges"]
    .select { |challenge| challenge["status"] == "active" }
    .sum do |challenge|
      if challenge["challengerId"] == user_id || challenge["receiverId"] == user_id
        challenge["stake"].to_i
      else
        0
      end
    end
end

def available_coins(state, user_id)
  user = find_user(state, user_id)
  return 0 unless user

  user["coins"].to_i - reserved_coins(state, user_id)
end

def challenge_visible_to?(challenge, user_id)
  challenge["challengerId"] == user_id || challenge["receiverId"] == user_id
end

def route_api(req, res)
  path = req.path

  if req.request_method == "GET" && path == "/api/state"
    state = load_state
    json_response(res, 200, state)
    return
  end

  if req.request_method == "POST" && path == "/api/register"
    payload = read_json_body(req)
    name = payload["name"].to_s.strip
    return error!(res, 422, "Inserisci un nome utente.") if name.empty?

    result = with_state do |state|
      existing_user = state["users"].find do |user|
        user["name"].downcase == name.downcase
      end

      if existing_user
        { user: existing_user, created: false }
      else
        user = {
          "id" => "user-#{SecureRandom.uuid}",
          "name" => name,
          "coins" => STARTING_COINS,
          "createdAt" => Time.now.utc.iso8601
        }
        state["users"] << user
        { user: user, created: true }
      end
    end

    json_response(res, 200, result)
    return
  end

  if req.request_method == "POST" && path == "/api/challenges"
    payload = read_json_body(req)
    challenger_id = payload["challengerId"].to_s
    receiver_id = payload["receiverId"].to_s

    begin
      result = with_state do |state|
        challenger = find_user(state, challenger_id)
        receiver = find_user(state, receiver_id)

        raise "Giocatore non trovato." unless challenger && receiver
        raise "Non puoi sfidare te stesso." if challenger_id == receiver_id

        duplicate_pending = state["challenges"].any? do |challenge|
          challenge["status"] == "pending" &&
            ((challenge["challengerId"] == challenger_id &&
              challenge["receiverId"] == receiver_id) ||
              (challenge["challengerId"] == receiver_id &&
                challenge["receiverId"] == challenger_id))
        end

        raise "Esiste gia una richiesta di sfida aperta tra questi due giocatori." if duplicate_pending

        challenge = {
          "id" => "challenge-#{SecureRandom.uuid}",
          "challengerId" => challenger_id,
          "receiverId" => receiver_id,
          "status" => "pending",
          "stake" => 0,
          "createdAt" => Time.now.utc.iso8601
        }

        state["challenges"].unshift(challenge)
        { message: "Sfida inviata a #{receiver["name"]}." }
      end

      json_response(res, 200, result)
    rescue StandardError => error
      error!(res, 422, error.message)
    end
    return
  end

  accept_match = path.match(%r{\A/api/challenges/([^/]+)/accept\z})
  if req.request_method == "POST" && accept_match
    challenge_id = accept_match[1]
    payload = read_json_body(req)
    user_id = payload["userId"].to_s
    stake = payload["stake"].to_i

    begin
      result = with_state do |state|
        challenge = state["challenges"].find { |item| item["id"] == challenge_id }
        raise "Richiesta non disponibile." unless challenge
        raise "Richiesta non disponibile." unless challenge["status"] == "pending"
        raise "Solo il destinatario puo accettare la sfida." unless challenge["receiverId"] == user_id
        raise "Inserisci un numero valido di monete." unless stake.positive?

        challenger = find_user(state, challenge["challengerId"])
        receiver = find_user(state, challenge["receiverId"])
        raise "Giocatori non disponibili." unless challenger && receiver

        challenger_available = available_coins(state, challenger["id"])
        receiver_available = available_coins(state, receiver["id"])

        if stake > challenger_available || stake > receiver_available
          raise "Puntata troppo alta. Disponibili: #{challenger["name"]} #{challenger_available}, #{receiver["name"]} #{receiver_available}."
        end

        challenge["status"] = "active"
        challenge["stake"] = stake
        challenge["acceptedAt"] = Time.now.utc.iso8601
        { message: "Sfida accettata: in palio #{stake} monete." }
      end

      json_response(res, 200, result)
    rescue StandardError => error
      error!(res, 422, error.message)
    end
    return
  end

  decline_match = path.match(%r{\A/api/challenges/([^/]+)/decline\z})
  if req.request_method == "POST" && decline_match
    challenge_id = decline_match[1]
    payload = read_json_body(req)
    user_id = payload["userId"].to_s

    begin
      result = with_state do |state|
        challenge = state["challenges"].find { |item| item["id"] == challenge_id }
        raise "Richiesta non disponibile." unless challenge
        raise "Richiesta non disponibile." unless challenge["status"] == "pending"
        raise "Solo il destinatario puo rifiutare la sfida." unless challenge["receiverId"] == user_id

        challenge["status"] = "declined"
        challenge["closedAt"] = Time.now.utc.iso8601
        { message: "Sfida rifiutata." }
      end

      json_response(res, 200, result)
    rescue StandardError => error
      error!(res, 422, error.message)
    end
    return
  end

  settle_match = path.match(%r{\A/api/challenges/([^/]+)/settle\z})
  if req.request_method == "POST" && settle_match
    challenge_id = settle_match[1]
    payload = read_json_body(req)
    user_id = payload["userId"].to_s
    winner_id = payload["winnerId"].to_s

    begin
      result = with_state do |state|
        challenge = state["challenges"].find { |item| item["id"] == challenge_id }
        raise "Sfida non disponibile." unless challenge
        raise "Sfida non disponibile." unless challenge["status"] == "active"
        raise "Non puoi chiudere questa sfida." unless challenge_visible_to?(challenge, user_id)

        challenger_id = challenge["challengerId"]
        receiver_id = challenge["receiverId"]
        valid_winner = [challenger_id, receiver_id].include?(winner_id)
        raise "Vincitore non valido." unless valid_winner

        loser_id = winner_id == challenger_id ? receiver_id : challenger_id
        winner = find_user(state, winner_id)
        loser = find_user(state, loser_id)
        raise "Giocatori non disponibili." unless winner && loser

        stake = challenge["stake"].to_i
        raise "La sfida non puo essere chiusa: #{loser["name"]} non ha abbastanza monete." if loser["coins"].to_i < stake

        loser["coins"] = loser["coins"].to_i - stake
        winner["coins"] = winner["coins"].to_i + stake
        challenge["status"] = "completed"
        challenge["winnerId"] = winner_id
        challenge["closedAt"] = Time.now.utc.iso8601

        { message: "#{winner["name"]} ha vinto #{stake} monete contro #{loser["name"]}." }
      end

      json_response(res, 200, result)
    rescue StandardError => error
      error!(res, 422, error.message)
    end
    return
  end

  if req.request_method == "POST" && path == "/api/reset"
    with_state do |state|
      state["users"] = []
      state["challenges"] = []
    end

    json_response(res, 200, { message: "Dati azzerati." })
    return
  end

  error!(res, 404, "Endpoint non trovato.")
end

def serve_file(req, res)
  path = req.path == "/" ? "/index.html" : req.path
  full_path = File.expand_path(path.delete_prefix("/"), __dir__)
  root = File.expand_path(__dir__)

  unless full_path.start_with?(root) && File.file?(full_path)
    res.status = 404
    res.body = "Not found"
    return
  end

  ext = File.extname(full_path)
  res.status = 200
  res["Content-Type"] = MIME_TYPES.fetch(ext, "text/plain; charset=utf-8")
  res.body = File.binread(full_path)
end

ensure_data_file!

server = WEBrick::HTTPServer.new(
  Port: PORT,
  BindAddress: "0.0.0.0",
  AccessLog: [],
  Logger: WEBrick::Log.new($stdout, WEBrick::Log::INFO)
)

server.mount_proc("/") do |req, res|
  if req.path.start_with?("/api/")
    route_api(req, res)
  else
    serve_file(req, res)
  end
end

trap("INT") { server.shutdown }
trap("TERM") { server.shutdown }

puts "Zona Sfide disponibile su http://localhost:#{PORT}"
server.start

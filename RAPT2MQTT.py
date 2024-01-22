import logging
import requests
import time
import json
from datetime import datetime
import paho.mqtt.client as mqtt
import paho.mqtt.publish as publish


#######################
"""Start MQTT stuff"""
#######################

#MQTT - Publish current actual and target temperatures
# The callback for when the client receives a CONNACK response from the server.
def on_connect(client, userdata, flags, rc):
    print("Connected. Result:"+str(rc))
    # Subscribing in on_connect() means that if we lose the connection and
    # reconnect then subscriptions will be renewed.
    #client.subscribe("$SYS/#")

#MQTT - Receive message and update RAPT target temperature
#Command must be published to "RAPT/temperatureController/Command"
#as: "Temperature" : "xx.xx"

# The callback for when a PUBLISH message is received from the server.
def on_message(client, userdata, msg):
  msg.payload = msg.payload.decode("utf-8")
  target_temp = json.loads('{' + msg.payload + '}')
  target_temp = target_temp["Temperature"]
  print("New temperature requested!: " + str(target_temp))
  set_temperature(headers, target_temp)

#######################
"""End of MQTT stuff"""
#######################


def update_token(user, secret):
#requests a validation token for the RAPT API
#Writes the current timestamp and the token to token.txt
  print('API Token Expired - Requesting new token!')

  headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json"
  }

  payload = {
    "client_id": "rapt-user",
    "grant_type": "password",
    "username": user,
    "password": secret
  }

  r = requests.post(
    "https://id.rapt.io/connect/token",
    data=payload,
    headers=headers
    )

  r.raise_for_status()

  response = r.json()
  token = response["access_token"]
  timestamp = time.time()
  timestamp = "%.0f" % timestamp
  timestamp = str(timestamp)

  #First time you use this, you probably want to do: 'sudo chmod 666 token.txt'
  #   or else you'll probably get 'permission denied' errors.
  outfile = open('token.txt', 'w')
  outfile.write(timestamp + '\n')
  outfile.write(token)
  outfile.close()

  print('Token Renewed.')



def retrieve_token(user, secret):
#Reads token.txt, checks if the token in the file is still valid (less than 1h old)
#Updates the file with a new token if it has expired, then returns the token
  try:
    file = open('token.txt', 'r')
    content = file.readlines()

  except FileNotFoundError:
    update_token(user,secret)
    file = open('token.txt', 'r')
    content = file.readlines()

  else:
    token_age = time.time() - float(content[0])
    if token_age > 3590:
      file.close()
      update_token(user, secret)
      file = open('token.txt', 'r')
      content = file.readlines()

    file.close()
    return content[1]



def set_temperature(headers, target):
  #!! this is a post request
  
  device_id = update_mqtt(headers)
  url = "https://api.rapt.io/api/TemperatureControllers/SetTargetTemperature"

  payload = {
    "temperatureControllerId": device_id,
    "target": target
  }

  r = requests.post(url, data=payload, headers=headers)
  r.raise_for_status()
  response = r.json()
  print ("Request to change temperature returned:" + str(response))
  time.sleep(5) #Just give it a sec to update on RAPT's end.
  update_mqtt(headers)




def update_mqtt(headers):
  #Get list of temperature controllers
  #I only have one. God help you if you have 2.
  get_teperature_controllers = "TemperatureControllers/GetTemperatureControllers"
  url = f"{api_endpoint}{get_teperature_controllers}"
  r = requests.get(url, headers=headers)
  r.raise_for_status()
  response = r.json()
  #print(response[0])

  #again, I only have one temperature controller, so this will be list index 0
  device_id = response[0]["id"]
  current_temp = "%.2f" % response[0]["temperature"]
  target_temp = "%.2f" % response[0]["targetTemperature"]

  #This is really just for logging. Turn this off or pipe it to STDOUT whatever.
  print(datetime.now().strftime("%B %d - %H:%M"))
  print('device_id: ' + device_id + '')
  print('target temperature: '+ target_temp + '')
  print('current temperature: '+ current_temp + '\n')

  #Publish to MQTT
  payload = '{"device_id": "%s","current_temp": "%s","target_temp": "%s"}' % (device_id, current_temp, target_temp)
  publish.single("RAPT/temperatureController", payload, hostname="192.168.0.252")

  #This is just to pass the device ID to the set_temperature function, otherwise it goes nowhere
  #Basically leaving this as a breadcrumb in case I ever get a second controller or 2 pill hydrometers
  return device_id


##########################
"""Body starts here"""
#########################


############
"""CONFIG"""
############

#RAPT API secrets (set this up in the RAPT portal - Account->API Secrets)
user = "some_email@gmail.com" #Email you use to log into RAPT
secret = "Some1337speak" #Your API secret
api_endpoint = "https://api.rapt.io/api/"

#MQTT Config -- also functions on_connect, on_message below.
client = mqtt.Client()
client.on_connect = on_connect
client.on_message = on_message
client.connect("Your Broker IP", 1883, 60) #Your MQTT server

#This is the topic HomeAssistant will publish to.
#Command must be published to "RAPT/temperatureController/Command"
#as: "Temperature" : "xx.xx"
client.subscribe("RAPT/temperatureController/Command")


#Get the auth token from RAPT API
#If the token has expired it will renew it automatically.
token = retrieve_token(user, secret)
#print(token)

#Define our headers to include the auth token
headers = {
  "Accept": "application/json",
  "Authorization": f"Bearer {token}"
  }

#Basically once every x seconds we will:
# -Check for a new target temperature on MQTT and send a request to RAPT to update the target temp.
# -Poll RAPT for the current target and actual temperatures
# -Publish current target and actual temperatures to MQTT
starttime = time.monotonic()
while True:
  client.loop()
  update_mqtt(headers)
  time.sleep(60.0 - ((time.monotonic() - starttime) % 60.0)) #Change 60 to whatever frequency you want.
  #This will run until cancelled, or until RAPT blocks you for too many requests.
  #If you're getting blocked, use a longer loop value or stop changing target temp so often.

